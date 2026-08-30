(() => {
  "use strict";

  const TERMINAL = new Set(["Completed", "Failed", "Cancelled"]);
  const WAITING = new Set(["Waiting for Approval", "Paused", "Needs Intervention"]);
  const QUIET_EVENTS = new Set(["lease_claimed", "lease_heartbeat"]);
  const UI_SURFACES = new Set(["browser", "desk", "frappe_desk", "ui", "computer"]);
  const ATTENDED_ACTION_PACE_MS = 850;
  const SAFE_PAYLOAD_KEYS = new Set([
    "actionLabel", "actionType", "approval", "changedFields", "currentRoute",
    "doctype", "documentName", "executionSurface", "fields", "fieldsAffected",
    "nodeKind", "pointer", "recordName", "route", "targetRoute", "toolAction",
    "verification", "verificationStatus", "viewport", "customizationEvidence", "takeoverLabel",
  ]);
  const FORBIDDEN_KEY = /password|passwd|secret|api.?key|token|authorization|cookie|private.?key|reasoning|chain.?of.?thought/i;

  function parsePayload(value) {
    if (!value) return {};
    if (typeof value === "object" && !Array.isArray(value)) return filterPayload(value);
    if (typeof value !== "string" || value.length > 65536) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? filterPayload(parsed) : {};
    } catch (_error) {
      return {};
    }
  }

  function filterPayload(payload) {
    const safe = {};
    Object.entries(payload).forEach(([key, value]) => {
      if (!SAFE_PAYLOAD_KEYS.has(key) || FORBIDDEN_KEY.test(key)) return;
      if (typeof value === "string") safe[key] = value.slice(0, 500);
      else if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
      else if (Array.isArray(value)) safe[key] = value.slice(0, 20).filter((item) => ["string", "number"].includes(typeof item)).map((item) => String(item).slice(0, 140));
      else if (value && typeof value === "object") {
        safe[key] = Object.fromEntries(Object.entries(value).filter(([childKey, childValue]) => !FORBIDDEN_KEY.test(childKey) && ["string", "number", "boolean"].includes(typeof childValue)).slice(0, 20));
      }
    });
    return safe;
  }

  function normalizedEvent(row) {
    return {
      sequence: Number(row.sequence) || 0,
      type: String(row.event_type || "activity").slice(0, 80),
      state: String(row.state || "").slice(0, 80),
      summary: String(row.summary || "Activity recorded").slice(0, 240),
      actor: String(row.actor || "").slice(0, 140),
      agent: String(row.agent || "").slice(0, 140),
      referenceDoctype: String(row.reference_doctype || "").slice(0, 140),
      referenceName: String(row.reference_name || "").slice(0, 140),
      creation: row.creation,
      payload: parsePayload(row.payload_json),
    };
  }

  function isExplicitUiAction(event) {
    if (!event || event.type !== "effect_started") return false;
    const payload = event.payload || {};
    return UI_SURFACES.has(String(payload.executionSurface || "").toLowerCase()) && Boolean(payload.actionLabel || payload.toolAction || payload.actionType);
  }

  function derivePresence(mission, events) {
    const status = String(mission?.status || "");
    if (WAITING.has(status)) return {key: "waiting", label: "Waiting for you"};
    if (TERMINAL.has(status) || !status) return {key: "user", label: "User control"};
    const latest = [...events].reverse().find((event) => !QUIET_EVENTS.has(event.type));
    if (latest?.type === "paused" || latest?.type === "pause_requested") return {key: "waiting", label: "Waiting for you"};
    if (isExplicitUiAction(latest)) return {key: "controlling", label: "Muster is controlling this work session"};
    return {key: "server", label: "Muster is working server-side"};
  }

  function routeFrom(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const payload = events[index].payload || {};
      const value = payload.currentRoute || payload.targetRoute || payload.route;
      if (typeof value !== "string") continue;
      const route = value.trim().replace(/^https?:\/\/[^/]+/i, "");
      if (route.startsWith("/desk/") || route === "/desk") return route.slice(0, 300);
    }
    return "";
  }

  function detailsFrom(events) {
    const fields = [];
    const approvals = [];
    const verifications = [];
    let doctype = "";
    let recordName = "";
    let customization = null;
    events.forEach((event) => {
      const payload = event.payload || {};
      doctype = String(payload.doctype || doctype).slice(0, 140);
      recordName = String(payload.documentName || payload.recordName || recordName).slice(0, 140);
      if (payload.customizationEvidence && typeof payload.customizationEvidence === "object") customization = payload.customizationEvidence;
      [payload.fieldsAffected, payload.changedFields, payload.fields].forEach((values) => {
        if (Array.isArray(values)) values.forEach((value) => fields.push(String(value).slice(0, 140)));
      });
      if (payload.approval && typeof payload.approval === "object") approvals.push(payload.approval);
      if (event.type !== "node_progress" && (event.type.includes("verification") || payload.nodeKind === "verification" || payload.verification || payload.verificationStatus)) {
        verifications.push(String(payload.verification || payload.verificationStatus || event.summary).slice(0, 240));
      }
    });
    return {doctype, recordName, fields: [...new Set(fields)].slice(0, 12), approvals: approvals.slice(-4), verifications: [...new Set(verifications)].slice(-4), customization};
  }

  function viewModel(mission, rows) {
    const events = (Array.isArray(rows) ? rows : []).map(normalizedEvent).sort((a, b) => a.sequence - b.sequence);
    const active = [...events].reverse().find((event) => !QUIET_EVENTS.has(event.type));
    return {
      mission: mission || {},
      events,
      presence: derivePresence(mission, events),
      route: routeFrom(events),
      details: detailsFrom(events),
      activeLabel: active?.type === "node_progress" ? "Latest progress" : "Current verified action",
      activeAction: active?.payload?.actionLabel || active?.payload?.toolAction || active?.summary || "Waiting for the first verified action",
      pointer: isExplicitUiAction(active) ? active.payload.pointer : null,
    };
  }

  const html = (value) => window.frappe?.utils?.escape_html ? frappe.utils.escape_html(String(value ?? "")) : String(value ?? "").replace(/[&<>"']/g, (character) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"})[character]);
  const t = (value) => typeof window.__ === "function" ? __(value) : value;

  class LiveWorkSession {
    constructor() {
      this.missionName = null;
      this.cursor = 0;
      this.rows = [];
      this.loading = false;
      this.testMode = Boolean(window.frappe?.boot?.muster?.test_mode) && window.frappe?.session?.user === "Administrator";
      this.element = document.createElement("section");
      this.element.className = "muster-live-session";
      this.element.setAttribute("aria-label", t("Muster live work session"));
      this.element.setAttribute("aria-hidden", "true");
      document.body.appendChild(this.element);
      window.frappe?.realtime?.on("muster_activity", (event) => {
        if (event.mission === this.missionName) this.refresh().catch(() => {});
      });
      window.frappe?.realtime?.on("muster_mission_changed", (event) => {
        if (event.mission === this.missionName) this.refresh().catch(() => {});
      });
      this.poll = window.setInterval(() => {
        if (this.missionName && document.visibilityState === "visible") this.refresh().catch(() => {});
      }, 5000);
    }

    async open(name) {
      if (!name) return;
      this.missionName = name;
      this.cursor = 0;
      this.rows = [];
      this.element.classList.add("is-open");
      this.element.setAttribute("aria-hidden", "false");
      this.renderLoading();
      await this.refresh();
    }

    close() {
      this.missionName = null;
      this.element.classList.remove("is-open");
      this.element.setAttribute("aria-hidden", "true");
    }

    async refresh() {
      if (!this.missionName || this.loading) return;
      this.loading = true;
      const name = this.missionName;
      try {
        const [mission, response] = await Promise.all([
          frappe.db.get_doc("Muster Mission", name),
          frappe.call("muster.api.mission.activities", {mission: name, after_sequence: this.cursor, limit: 200}),
        ]);
        if (name !== this.missionName) return;
        const fresh = response.message || [];
        this.rows = [...this.rows, ...fresh].slice(-200);
        this.cursor = this.rows.reduce((maximum, row) => Math.max(maximum, Number(row.sequence) || 0), this.cursor);
        this.render(viewModel(mission, this.rows));
      } catch (error) {
        if (name === this.missionName) this.renderError();
        throw error;
      } finally {
        this.loading = false;
      }
    }

    renderLoading() {
      this.element.innerHTML = `<div class="muster-live-loading" role="status">${html(t("Loading verified work session…"))}</div>`;
    }

    renderError() {
      this.element.innerHTML = `<div class="muster-live-error" role="alert"><strong>${html(t("This work session could not be loaded."))}</strong><button type="button" class="btn btn-sm btn-default" data-live-close>${html(t("Close"))}</button></div>`;
      this.bind();
    }

    render(model) {
      const {mission, events, presence, route, details} = model;
      const canControl = mission.requested_by === frappe.session.user && !TERMINAL.has(mission.status) && Boolean(mission.root_run_id);
      const pointer = model.pointer && typeof model.pointer === "object" ? model.pointer : {};
      const pointerX = Math.max(4, Math.min(92, Number(pointer.x) || 64));
      const pointerY = Math.max(8, Math.min(84, Number(pointer.y) || 46));
      const timeline = events.slice(-30).reverse().map((event) => `<li data-event-type="${html(event.type)}"><span class="muster-live-event-dot"></span><div><strong>${html(event.summary)}</strong><small>${html(event.agent || event.actor || event.state || event.type)}${event.creation ? ` · ${html(frappe.datetime.prettyDate(event.creation))}` : ""}</small></div></li>`).join("");
      const fieldMarkup = details.fields.length ? details.fields.map((field) => `<span>${html(field)}</span>`).join("") : `<small>${html(t("No field changes reported yet"))}</small>`;
      const approvalMarkup = mission.status === "Waiting for Approval" || details.approvals.length
        ? `<div class="muster-live-proof is-approval"><b>${html(t("Approval"))}</b><span>${html(mission.status === "Waiting for Approval" ? t("A decision is required before Muster can continue") : t("Approval evidence recorded"))}</span></div>` : "";
      const verificationMarkup = details.verifications.length ? `<div class="muster-live-proof is-verified"><b>${html(t("Verification"))}</b><span>${html(details.verifications.at(-1))}</span></div>` : "";
      const customizationMarkup = details.customization ? `<div class="muster-live-proof is-verified"><b>${html(t("Effective form checked"))}</b><span>${html(`${t("Detected")} ${Number(details.customization.customFieldCount) || 0} ${t("custom field(s)")}, ${Number(details.customization.propertySetterCount) || 0} ${t("property setter(s)")}, ${Number(details.customization.customPermissionCount) || 0} ${t("custom permission row(s)")}, ${Number(details.customization.clientScriptCount) || 0} ${t("Client Script(s)")}, ${Number(details.customization.serverScriptCount) || 0} ${t("Server Script(s)")}${details.customization.workflowDetected ? `, ${t("and an active workflow")}` : ""}`)}</span></div>` : "";
      const cursorMarkup = presence.key === "controlling" ? `<div class="muster-virtual-cursor" style="--cursor-x:${pointerX}%;--cursor-y:${pointerY}%" aria-label="${html(t("Muster virtual cursor"))}"><i></i><span>${html(t("Muster has taken over"))}</span></div>` : "";
      const pauseAction = mission.status === "Paused" ? "resume" : "pause";
      this.element.innerHTML = `
        <header class="muster-live-header">
          <div><p>${html(t("Live autonomous work session"))}</p><h2>${html(mission.objective || mission.name)}</h2></div>
          <button type="button" class="muster-live-close" data-live-close aria-label="${html(t("Close live work session"))}">×</button>
        </header>
        <div class="muster-live-presence" data-presence="${presence.key}" role="status" aria-live="polite"><span></span><strong>${html(t(presence.label))}</strong><small>${html(mission.status || "")}</small></div>
        <div class="muster-live-controls">
          ${canControl ? `<button type="button" class="btn btn-sm btn-default" data-live-control="${pauseAction}">${html(t(pauseAction === "pause" ? "Pause and take control" : "Resume Muster"))}</button>` : ""}
          ${canControl ? `<button type="button" class="btn btn-sm btn-default" data-live-steer>${html(t("Guide"))}</button>` : ""}
          <a class="btn btn-sm btn-default" href="/desk/muster-mission/${encodeURIComponent(mission.name)}">${html(t("Audit record"))}</a>
        </div>
        <section class="muster-live-viewport" aria-label="${html(t("Observed Muster work surface"))}">
          <div class="muster-live-browser-bar"><span></span><span></span><span></span><code>${html(route || t("Server-side work — no Desk route reported"))}</code>${route ? `<a href="${html(route)}">${html(t("Open"))}</a>` : ""}</div>
          <div class="muster-live-canvas" data-presence="${presence.key}">
            ${cursorMarkup}
            <div class="muster-live-action"><small>${html(t(model.activeLabel))}</small><strong>${html(model.activeAction)}</strong></div>
            <div class="muster-live-target"><div><small>${html(t("Target"))}</small><strong>${html([details.doctype, details.recordName].filter(Boolean).join(" · ") || t("Not reported yet"))}</strong></div><div class="muster-live-fields"><small>${html(t("Fields affected"))}</small>${fieldMarkup}</div></div>
            ${customizationMarkup}${approvalMarkup}${verificationMarkup}
          </div>
        </section>
        <section class="muster-live-timeline"><header><h3>${html(t("Verified activity"))}</h3><small>${html(t("High-level actions only — no private reasoning or secrets"))}</small></header><ol>${timeline || `<li class="is-empty">${html(t("Waiting for the first authenticated run event"))}</li>`}</ol></section>`;
      this.bind();
    }

    bind() {
      this.element.querySelectorAll("[data-live-close]").forEach((button) => button.addEventListener("click", () => this.close()));
      this.element.querySelectorAll("[data-live-control]").forEach((button) => button.addEventListener("click", () => this.control(button.dataset.liveControl)));
      this.element.querySelector("[data-live-steer]")?.addEventListener("click", () => this.steer());
    }

    async control(action, note) {
      const button = this.element.querySelector(`[data-live-control="${action}"]`);
      if (button) button.disabled = true;
      try {
        await frappe.call({method: "muster.api.mission.control", type: "POST", args: {mission: this.missionName, action, note, idempotency_key: frappe.utils.get_random(24)}});
        await this.refresh();
      } finally {
        if (button) button.disabled = false;
      }
    }

    steer() {
      const dialog = new frappe.ui.Dialog({
        title: t("Guide this work session"),
        fields: [{fieldname: "note", fieldtype: "Small Text", label: t("Instruction"), reqd: 1, description: t("This becomes a durable, audited steering command.")}],
        primary_action_label: t("Send guidance"),
        primary_action: async ({note}) => { await this.control("steer", note); dialog.hide(); },
      });
      dialog.show();
    }

    loadTestEvents(mission, rows) {
      if (!this.testMode) throw new Error("Muster deterministic playback requires explicit Administrator test mode.");
      this.missionName = mission.name;
      this.rows = rows;
      this.element.classList.add("is-open", "is-test-playback");
      this.element.setAttribute("aria-hidden", "false");
      this.render(viewModel(mission, rows));
    }
  }

  function attendedReceipt(value) {
    if (!value || typeof value !== "object" || value.save_requires_confirmation !== true || typeof value.save_authorized !== "boolean" || value.executed !== false) throw new Error(t("Muster could not verify this attended preview."));
    const text = (input, maximum = 500, multiline = false) => {
      const invalidControl = multiline
        ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
        : /[\u0000-\u001f\u007f]/;
      if (typeof input !== "string" || !input.trim() || input.length > maximum || invalidControl.test(input)) throw new Error(t("Muster could not verify this attended preview."));
      return input;
    };
    if (!["create", "update"].includes(value.operation) || !Array.isArray(value.fields) || !value.fields.length || value.fields.length > 100) throw new Error(t("Muster could not verify this attended preview."));
    const scalarField = (field) => ({
      fieldname: text(field?.fieldname, 140),
      label: text(field?.label, 140),
      control: ["fill", "select"].includes(field?.control) ? field.control : (() => { throw new Error(t("Muster could not verify this attended preview.")); })(),
      value: text(String(field?.value ?? ""), 10_000),
    });
    const fields = value.fields.map((field) => {
      if (field?.control !== "table") return scalarField(field);
      if (!Array.isArray(field.rows) || !field.rows.length || field.rows.length > 20) throw new Error(t("Muster could not verify this attended preview."));
      const rows = field.rows.map((row) => {
        if (!Array.isArray(row) || !row.length || row.length > 40) throw new Error(t("Muster could not verify this attended preview."));
        const normalized = row.map(scalarField);
        if (new Set(normalized.map((child) => child.fieldname)).size !== normalized.length) throw new Error(t("Muster could not verify this attended preview."));
        return Object.freeze(normalized);
      });
      return {
        fieldname: text(field.fieldname, 140), label: text(field.label, 140), control: "table",
        childDoctype: text(field.child_doctype, 140), rows: Object.freeze(rows),
      };
    });
    if (new Set(fields.map((field) => field.fieldname)).size !== fields.length) throw new Error(t("Muster could not verify this attended preview."));
    const recordName = value.record_name == null ? null : value.record_name;
    const recordRevision = value.record_revision == null ? null : value.record_revision;
    if ((value.operation === "update" && recordName === null)
      || (value.operation === "create" && (recordName !== null || recordRevision !== null))) throw new Error(t("Muster could not verify this attended preview."));
    const submitRequested = value.submit_requested === true;
    if (submitRequested && (value.submit_requires_confirmation !== true || typeof value.submit_authorized !== "boolean")) {
      throw new Error(t("Muster could not verify this attended preview."));
    }
    return Object.freeze({
      proposal: text(value.proposal, 140), objective: text(value.objective, 10_000, true),
      operation: value.operation, doctype: text(value.doctype, 140),
      recordName: value.operation === "update" ? text(recordName) : null,
      recordRevision: value.operation === "update" ? text(recordRevision, 100) : null,
      saveAuthorized: value.save_authorized,
      submitRequested,
      submitAuthorized: submitRequested && value.submit_authorized === true,
      fields: Object.freeze(fields),
    });
  }

  function attendedDeleteReceipt(value) {
    const text = (input, maximum = 500) => {
      if (typeof input !== "string" || !input.trim() || input.length > maximum || /[\u0000-\u001f]/.test(input)) throw new Error(t("Muster could not verify this delete review."));
      return input;
    };
    if (!value || typeof value !== "object" || value.operation !== "delete" || value.delete_requires_confirmation !== true || typeof value.delete_authorized !== "boolean" || value.executed !== false || !Array.isArray(value.fields) || value.fields.length) throw new Error(t("Muster could not verify this delete review."));
    const approvalProof = value.approval_proof == null ? null : value.approval_proof;
    if ((value.delete_authorized && (typeof approvalProof !== "string" || !/^[a-f0-9]{64}$/.test(approvalProof)))
      || (!value.delete_authorized && approvalProof !== null)) throw new Error(t("Muster could not verify this delete review."));
    return Object.freeze({
      proposal: text(value.proposal, 140), objective: text(value.objective, 10_000), operation: "delete",
      doctype: text(value.doctype, 140), recordName: text(value.record_name), recordRevision: text(value.record_revision, 100),
      approvalProof, deleteAuthorized: value.delete_authorized, saveAuthorized: false, fields: Object.freeze([]),
    });
  }

  function attendedControlUnavailable(control) {
    const enabled = (value) => value === true || value === 1 || value === "1";
    return !control || enabled(control.df?.read_only) || enabled(control.df?.hidden);
  }

  function plainControlText(value, maximum = 240) {
    const fallback = String(value || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
    const container = document.createElement?.("div");
    if (!container) return fallback.slice(0, maximum);
    container.innerHTML = String(value || "");
    return String(container.textContent || container.innerText || fallback).replace(/\s+/g, " ").trim().slice(0, maximum);
  }

  function attendedFieldGuidance(control, field, value) {
    const definition = control?.df || {};
    const label = String(field?.label || definition.label || t("This field")).trim();
    const required = definition.reqd ? ` ${t("It is required before this document can move forward.")}` : "";
    const description = plainControlText(definition.description);
    if (description) return `${label}: ${description}${required}`;
    const option = String(definition.options || "").trim();
    const type = String(definition.fieldtype || "Data");
    if (type === "Link") return `${label}: ${t("choose an existing")} ${option || t("record")} ${t("from the live system. Start typing to search the records you are permitted to use.")}${required}`;
    if (type === "Date" || type === "Datetime") return `${label}: ${t("choose the business date that should control this step and its downstream schedule.")}${required}`;
    if (type === "Select") return `${label}: ${t("choose one of the options allowed by this form.")}${required}`;
    if (type === "Check") return `${label}: ${t("turn this on only when the statement applies to this document.")}${required}`;
    if (["Currency", "Float", "Int", "Percent"].includes(type)) return `${label}: ${t("enter the business value shown in the document's unit or currency.")}${required}`;
    if (type === "Table" || type === "Table MultiSelect") return `${label}: ${t("this is a child table. Each row is one business line with its own item, quantity, schedule, rate, or other row details.")}${required}`;
    const example = String(value ?? "").trim();
    return `${label}: ${t("enter the value used by the business for this document")}${example ? ` (${t("this guided example uses")} ${example.slice(0, 80)})` : ""}.${required}`;
  }

  function attendedActionGuidance(label) {
    const normalized = String(label || "").replace(/\s+/g, " ").trim();
    const key = normalized.toLowerCase();
    if (!normalized) return "";
    if (key.includes("get items from")) return `${normalized}: ${t("bring approved lines from an earlier document instead of entering them again. The available source documents depend on this form and your permissions.")}`;
    if (key === "add row" || key.includes("add multiple")) return `${normalized}: ${t("add another line to the child table. Each line is validated independently before Save.")}`;
    if (key === "save") return `${normalized}: ${t("store this as a draft so it can still be reviewed and edited. Saving is not the same as submitting.")}`;
    if (key === "submit") return `${normalized}: ${t("finalize this document and trigger its configured workflow or accounting and stock effects. Muster pauses for human approval before this action.")}`;
    return `${normalized}: ${t("this action is available on the live form. Muster will explain its effect and ask before using it; training never guesses what a custom action does.")}`;
  }

  function savePreflightMatches(value, preview) {
    if (!value || !preview || value.current !== true || value.executed !== false
      || value.proposal !== preview.proposal || value.operation !== preview.operation
      || value.doctype !== preview.doctype || !Array.isArray(value.fields)
      || value.fields.length !== preview.fields.length) return false;
    if (preview.operation === "update" && (
      value.record_name !== preview.recordName || value.record_revision !== preview.recordRevision
    )) return false;
    if (preview.operation === "create" && (value.record_name != null || value.record_revision != null)) return false;
    return value.fields.every((field, index) => {
      const expected = preview.fields[index];
      if (!field || !expected || field.fieldname !== expected.fieldname
        || field.label !== expected.label || field.control !== expected.control) return false;
      if (expected.control !== "table") return String(field.value ?? "") === expected.value;
      if (!Array.isArray(field.rows) || field.child_doctype !== expected.childDoctype
        || field.rows.length !== expected.rows.length) return false;
      return field.rows.every((row, rowIndex) => Array.isArray(row)
        && row.length === expected.rows[rowIndex].length
        && row.every((child, childIndex) => {
          const expectedChild = expected.rows[rowIndex][childIndex];
          return child?.fieldname === expectedChild.fieldname && child?.label === expectedChild.label
            && child?.control === expectedChild.control && String(child?.value ?? "") === expectedChild.value;
        }));
    });
  }

  function attendedElement(value) {
    if (!value) return null;
    if (value.nodeType === 1) return value;
    if (value[0]?.nodeType === 1) return value[0];
    return null;
  }

  function attendedElementVisible(value) {
    const element = attendedElement(value);
    if (!element || element.isConnected === false || element.hidden) return false;
    const hiddenAncestor = element.closest?.("[hidden], [aria-hidden='true'], .hide, .hidden");
    if (hiddenAncestor) return false;
    const style = window.getComputedStyle?.(element);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
    const rectangle = element.getBoundingClientRect?.();
    return Boolean(rectangle && rectangle.width > 0 && rectangle.height > 0);
  }

  class AttendedDeskPreview {
    constructor() {
      this.preview = null;
      this.cancelled = false;
      this.overlay = null;
      this.lastCursor = null;
      this.deleteReady = false;
      this.deleteInFlight = false;
      this.draftVerified = false;
    }

    async start(receipt) {
      if (this.preview) throw new Error(t("Another attended preview is already active."));
      this.preview = attendedReceipt(receipt);
      this.cancelled = false;
      this.lastCursor = null;
      this.deleteReady = false;
      this.deleteInFlight = false;
      this.draftVerified = false;
      this.renderStatus(t("Guided training"), t("Opening the live form and reading the controls available to you…"), false);
      try {
        await this.openActualForm();
        for (const field of this.preview.fields) {
          this.assertActiveForm();
          if (field.control === "table") {
            await this.fillTable(field);
            continue;
          }
          const currentValue = String(cur_frm.doc?.[field.fieldname] ?? "").trim();
          const expectedValue = String(field.value).trim();
          const wrapper = cur_frm.fields_dict?.[field.fieldname]?.$wrapper;
          await this.revealField(field.fieldname);
          if (attendedElementVisible(wrapper)) {
            await this.pointToField(field);
            this.renderStatus(t("What this field means"), attendedFieldGuidance(cur_frm.fields_dict?.[field.fieldname], field, field.value), false);
            await this.delay(ATTENDED_ACTION_PACE_MS);
          }
          if (currentValue === expectedValue) {
            this.renderStatus(t("Guided training"), `${t("Keeping")} ${field.label}: ${expectedValue}`, false);
            await this.delay(ATTENDED_ACTION_PACE_MS);
            continue;
          }
          if (attendedControlUnavailable(cur_frm.fields_dict?.[field.fieldname])) {
            throw new Error(`${field.label}: ${t("this field is no longer available for attended work.")}`);
          }
          await cur_frm.set_value(field.fieldname, field.value);
          this.assertActiveForm();
          if (!attendedElementVisible(wrapper) && String(cur_frm.doc?.[field.fieldname] ?? "").trim() !== expectedValue) {
            throw new Error(`${field.label}: ${t("the real form control is no longer available.")}`);
          }
          this.renderStatus(t("Guided training"), `${t("Filled")} ${field.label}: ${expectedValue}`, false);
          await this.delay(ATTENDED_ACTION_PACE_MS);
        }
        await this.explainVisibleActions();
        this.renderStatus(
          t("Review before Save"),
          this.preview.saveAuthorized
            ? t("The live form is ready. Save keeps a draft; Submit finalizes it and may trigger workflow, stock, or accounting effects. Review the form before approving Save.")
            : t("The live form is ready. Review the fields, buttons, and child rows, then return for approval before Muster can Save."),
          true,
        );
      } catch (error) {
        console.error("Muster attended preview stopped", error);
        this.finish();
        throw error;
      }
    }

    async startDelete(receipt) {
      if (this.preview) throw new Error(t("Another attended preview is already active."));
      this.preview = attendedDeleteReceipt(receipt);
      this.cancelled = false;
      this.lastCursor = null;
      this.deleteReady = false;
      this.renderStatus(t("Muster has taken over"), t("Opening the reviewed record…"), false);
      try {
        await this.openActualForm();
        await this.pointToElement(this.activeForm().wrapper || this.activeForm().page?.wrapper || this.activeForm().$wrapper);
        this.renderStatus(
          t("Review before Delete"),
          this.preview.deleteAuthorized
            ? t("The exact record is open. Type its name to authorize one visible native Frappe deletion.")
            : t("Return to the proposal for destructive-action approval. Muster has not opened or clicked Delete."),
          true,
        );
      } catch (error) {
        this.finish();
        throw error;
      }
    }

    async openActualForm() {
      const {operation, doctype, recordName} = this.preview;
      if (operation === "update" || operation === "delete") {
        frappe.set_route("Form", doctype, recordName);
        await this.waitFor(() => Boolean(this.visibleExactForm()));
        this.assertRecordRevision(this.visibleExactForm());
      } else {
        frappe.set_route("List", doctype);
        this.renderStatus(t("Muster has taken over"), `${t("Opening")} ${doctype} ${t("list…")}`, false);
        await this.waitFor(() => Boolean(this.activeListPrimaryAction()));
        const primary = this.activeListPrimaryAction();
        if (!primary) throw new Error(t("The real Frappe list action is not visible."));
        await this.pointToElement(primary);
        this.renderStatus(t("Muster has taken over"), `${t("Selecting New")} ${doctype}…`, false);
        primary.click();
        await this.waitFor(() => Boolean(this.activeForm() || this.activeQuickEntryFullFormAction()));
        if (!this.activeForm()) {
          const fullForm = this.activeQuickEntryFullFormAction();
          if (!fullForm) throw new Error(t("The real Frappe create form is not visible."));
          await this.pointToElement(fullForm);
          this.renderStatus(t("Muster has taken over"), `${t("Opening full")} ${doctype} ${t("form…")}`, false);
          fullForm.click();
        }
      }
      await this.waitFor(() => Boolean(this.activeForm()));
      await this.waitForFormToSettle();
      this.assertActiveForm();
    }

    async waitForFormToSettle() {
      let previous = "";
      let stableChecks = 0;
      const started = Date.now();
      while (stableChecks < 5) {
        const form = this.activeForm();
        if (form && !form.refreshing && !form.is_saving) {
          const current = JSON.stringify(this.preview.fields.map((field) => form.doc?.[field.fieldname] ?? null));
          stableChecks = current === previous ? stableChecks + 1 : 0;
          previous = current;
        } else {
          stableChecks = 0;
        }
        if (Date.now() - started >= 15_000) throw new Error(t("The reviewed Frappe form did not finish loading in time."));
        await this.delay(100);
      }
    }

    activeQuickEntryFullFormAction() {
      if (!this.preview || this.preview.operation !== "create") return null;
      const route = frappe.get_route?.() || [];
      if (route[0] !== "List" || route[1] !== this.preview.doctype) return null;
      const dialogs = [...document.querySelectorAll(".modal.show, .modal.in")].filter(attendedElementVisible);
      const expected = this.preview.doctype.toLowerCase();
      const dialog = dialogs.find((candidate) => {
        const title = candidate.querySelector?.(".modal-title")?.textContent?.trim().toLowerCase() || "";
        return title.includes(expected);
      });
      if (!dialog) return null;
      const expectedLabel = t("Edit Full Form").trim().toLowerCase();
      const action = [...dialog.querySelectorAll("button")].find((button) =>
        attendedElementVisible(button) && button.textContent?.trim().toLowerCase() === expectedLabel
      );
      return action && typeof action.click === "function" ? action : null;
    }

    activeListPrimaryAction() {
      if (!this.preview || this.preview.operation !== "create") return null;
      const route = frappe.get_route?.() || [];
      const list = window.cur_list;
      if (route[0] !== "List" || route[1] !== this.preview.doctype || list?.doctype !== this.preview.doctype || !attendedElementVisible(list.page?.wrapper)) return null;
      const primary = attendedElement(list.page?.btn_primary);
      return attendedElementVisible(primary) && typeof primary.click === "function" ? primary : null;
    }

    activeForm() {
      const form = this.visibleExactForm();
      if (!form) return null;
      if (["update", "delete"].includes(this.preview.operation) && String(form.doc?.modified || "") !== this.preview.recordRevision) return null;
      return form;
    }

    visibleExactForm() {
      if (!this.preview) return null;
      const route = frappe.get_route?.() || [];
      const form = window.cur_frm;
      if (route[0] !== "Form" || route[1] !== this.preview.doctype || !form || form.doctype !== this.preview.doctype || route[2] !== form.docname || !attendedElementVisible(form.wrapper || form.page?.wrapper || form.$wrapper)) return null;
      if (["update", "delete"].includes(this.preview.operation) && form.docname !== this.preview.recordName) return null;
      if (this.preview.operation === "create" && !(form.doc?.__islocal || form.doc?.__unsaved)) return null;
      return form;
    }

    assertRecordRevision(form = this.visibleExactForm()) {
      if (!["update", "delete"].includes(this.preview?.operation)) return;
      if (!form || String(form.doc?.modified || "") !== this.preview.recordRevision) throw new Error(t("This record changed after review. Muster stopped; reload and prepare the action again."));
    }

    assertActiveForm() {
      const form = this.activeForm();
      if (this.cancelled || !form) throw new Error(t("The attended preview stopped because the real editable form is not visibly active."));
      this.assertRecordRevision(form);
      this.preview.fields.forEach((field) => {
        const control = form.fields_dict?.[field.fieldname];
        if (!control) throw new Error(`${field.label}: ${t("this field is no longer available for attended work.")}`);
      });
    }

    async pointToField(field) {
      await this.revealField(field.fieldname);
      const wrapper = cur_frm.fields_dict[field.fieldname]?.$wrapper?.[0];
      if (!attendedElementVisible(wrapper)) throw new Error(`${field.label}: ${t("the real form control is not visible.")}`);
      await this.pointToElement(wrapper);
    }

    async revealField(fieldname) {
      const form = this.activeForm();
      const control = form?.fields_dict?.[fieldname];
      if (!form || !control) return;
      if (!attendedElementVisible(control.$wrapper) && typeof form.scroll_to_field === "function") {
        form.scroll_to_field(fieldname, false);
        await this.delay(150);
      }
    }

    async fillTable(field) {
      const form = this.activeForm();
      const control = form?.fields_dict?.[field.fieldname];
      if (!form || attendedControlUnavailable(control) || !control.grid) throw new Error(`${field.label}: ${t("the real child table is not available.")}`);
      await this.pointToField(field);
      this.renderStatus(t("How this table works"), attendedFieldGuidance(control, field, ""), false);
      await this.delay(ATTENDED_ACTION_PACE_MS);
      const addRow = this.visibleActionByLabel(control.$wrapper || control.wrapper, [t("Add Row"), t("Add Multiple")]);
      if (addRow) {
        await this.pointToElement(addRow);
        this.renderStatus(t("Child-table control"), attendedActionGuidance(String(addRow.textContent || "").trim()), false);
        await this.delay(ATTENDED_ACTION_PACE_MS);
      }
      if (typeof frappe.model?.clear_table === "function") frappe.model.clear_table(form.doc, field.fieldname);
      else if (Array.isArray(form.doc?.[field.fieldname])) form.doc[field.fieldname] = [];
      for (let rowIndex = 0; rowIndex < field.rows.length; rowIndex += 1) {
        this.assertActiveForm();
        const rowFields = field.rows[rowIndex];
        if (typeof form.add_child !== "function") throw new Error(`${field.label}: ${t("the real child row action is unavailable.")}`);
        const row = form.add_child(field.fieldname);
        if (!row?.doctype || !row?.name || typeof frappe.model?.set_value !== "function") {
          throw new Error(`${field.label}: ${t("the real child row fields are unavailable.")}`);
        }
        form.refresh_field?.(field.fieldname);
        await this.delay(ATTENDED_ACTION_PACE_MS);
        for (const child of rowFields) {
          const childDefinition = control?.grid?.docfields?.find?.((candidate) => candidate.fieldname === child.fieldname);
          const childControl = {df: childDefinition || {label: child.label}};
          if (String(row[child.fieldname] ?? "").trim() !== String(child.value).trim()) {
            await frappe.model.set_value(row.doctype, row.name, child.fieldname, child.value);
            this.assertActiveForm();
            form.refresh_field?.(field.fieldname);
          }
          const cell = this.childCell(control, rowIndex, child.fieldname);
          const rowElement = attendedElement(control?.grid?.grid_rows?.[rowIndex]?.row || control?.grid?.grid_rows?.[rowIndex]?.wrapper);
          if (!cell && !attendedElementVisible(rowElement)) throw new Error(`${child.label}: ${t("the real child row is not visible.")}`);
          await this.pointToElement(cell || rowElement);
          this.renderStatus(t("What this row value means"), `${attendedFieldGuidance(childControl, child, child.value)} ${t("This is row")} ${rowIndex + 1}.`, false);
          await this.delay(ATTENDED_ACTION_PACE_MS);
        }
      }
      form.refresh_field?.(field.fieldname);
    }

    visibleActionByLabel(rootValue, labels) {
      const root = attendedElement(rootValue);
      if (!root?.querySelectorAll) return null;
      const accepted = new Set(labels.map((label) => String(label || "").trim().toLowerCase()).filter(Boolean));
      return [...root.querySelectorAll("button, a.btn")].find((candidate) =>
        attendedElementVisible(candidate)
        && accepted.has(String(candidate.textContent || "").replace(/\s+/g, " ").trim().toLowerCase())
      ) || null;
    }

    visibleTeachingActions() {
      const form = this.activeForm();
      const root = attendedElement(form?.page?.wrapper) || attendedElement(form?.wrapper) || attendedElement(form?.$wrapper);
      if (!root?.querySelectorAll) return [];
      const preferred = ["get items from", "add row", "add multiple", "save", "submit"];
      const seen = new Set();
      return [...root.querySelectorAll("button, a.btn")]
        .filter(attendedElementVisible)
        .map((element) => ({element, label: String(element.textContent || "").replace(/\s+/g, " ").trim()}))
        .filter(({label}) => label && label.length <= 80 && !seen.has(label.toLowerCase()) && seen.add(label.toLowerCase()))
        .sort((left, right) => preferred.indexOf(left.label.toLowerCase()) - preferred.indexOf(right.label.toLowerCase()))
        .filter(({label}) => preferred.some((name) => label.toLowerCase().includes(name)))
        .slice(0, 8);
    }

    async explainVisibleActions() {
      for (const action of this.visibleTeachingActions()) {
        await this.pointToElement(action.element);
        this.renderStatus(t("What this button does"), attendedActionGuidance(action.label), false);
        await this.delay(ATTENDED_ACTION_PACE_MS);
      }
    }

    childCell(control, rowIndex, fieldname) {
      const row = control?.grid?.grid_rows?.[rowIndex];
      const rowElement = attendedElement(row?.row || row?.wrapper);
      if (!attendedElementVisible(rowElement)) return null;
      const escaped = window.CSS?.escape ? window.CSS.escape(fieldname) : fieldname.replace(/[^A-Za-z0-9_-]/g, "");
      const cell = rowElement.querySelector?.(`[data-fieldname="${escaped}"]`);
      return attendedElementVisible(cell) ? cell : null;
    }

    async pointToElement(value) {
      const element = attendedElement(value);
      if (!attendedElementVisible(element)) throw new Error(t("The real Frappe control is not visible."));
      element.scrollIntoView?.({behavior: "smooth", block: "center"});
      const rectangle = element.getBoundingClientRect();
      this.lastCursor = {
        x: `${Math.max(12, Math.min(window.innerWidth - 30, rectangle.left + rectangle.width * .72))}px`,
        y: `${Math.max(70, Math.min(window.innerHeight - 40, rectangle.top + rectangle.height * .5))}px`,
      };
      this.applyCursor();
      await this.delay(ATTENDED_ACTION_PACE_MS);
    }

    applyCursor() {
      if (!this.lastCursor) return;
      const cursor = this.overlay?.querySelector("[data-attended-cursor]");
      cursor?.style?.setProperty("--attended-x", this.lastCursor.x);
      cursor?.style?.setProperty("--attended-y", this.lastCursor.y);
    }

    renderStatus(title, detail, waiting) {
      if (!this.overlay) {
        this.overlay = document.createElement("section");
        this.overlay.className = "muster-attended-overlay";
        this.overlay.setAttribute("role", "status");
        this.overlay.dataset.musterTakeover = "true";
        document.body.appendChild(this.overlay);
      }
      this.overlay.dataset.waiting = waiting ? "true" : "false";
      this.overlay.dataset.musterTakeoverState = waiting ? "waiting" : "working";
      const decision = waiting && this.draftVerified && this.preview?.submitRequested && this.preview?.submitAuthorized
        ? `<button type="button" class="btn btn-sm btn-default" data-attended-stop>${html(t("Take control"))}</button><button type="button" class="btn btn-sm btn-primary" data-attended-submit>${html(t("Continue to Submit"))}</button>`
        : waiting && this.preview?.operation === "delete" && this.deleteReady
        ? `<button type="button" class="btn btn-sm btn-default" data-attended-stop>${html(t("Take control"))}</button>`
        : waiting && this.preview?.operation === "delete" && this.preview.deleteAuthorized
          ? `<button type="button" class="btn btn-sm btn-default" data-attended-stop>${html(t("Take control"))}</button><button type="button" class="btn btn-sm btn-danger" data-attended-delete>${html(t("Begin delete review"))}</button>`
          : waiting && this.preview?.saveAuthorized
        ? `<button type="button" class="btn btn-sm btn-default" data-attended-stop>${html(t("Take control"))}</button><button type="button" class="btn btn-sm btn-primary" data-attended-save>${html(t("Approve and Save"))}</button>`
        : waiting ? `<button type="button" class="btn btn-sm btn-default" data-attended-stop>${html(t("Take control"))}</button><button type="button" class="btn btn-sm btn-primary" data-attended-review>${html(t("Return for approval"))}</button>` : "";
      const cursorLabel = waiting ? t("Muster paused here") : t("Muster is guiding you");
      this.overlay.innerHTML = `<div class="muster-attended-banner"><img src="/assets/muster/images/muster-mark.png" alt=""><div><strong>${html(title)}</strong><small>${html(detail)}</small></div>${decision}</div><div class="muster-attended-cursor" data-attended-cursor aria-label="${html(cursorLabel)}"><i></i><span>${html(cursorLabel)}</span></div>`;
      this.applyCursor();
      this.overlay.querySelector("[data-attended-stop]")?.addEventListener("click", () => this.stop());
      this.overlay.querySelector("[data-attended-save]")?.addEventListener("click", () => this.confirmSave());
      this.overlay.querySelector("[data-attended-submit]")?.addEventListener("click", () => this.submit().catch((error) => this.showStopped(error)));
      this.overlay.querySelector("[data-attended-delete]")?.addEventListener("click", () => this.requestDeleteInitiation());
      this.overlay.querySelector("[data-attended-review]")?.addEventListener("click", () => this.returnForApproval().catch((error) => this.showStopped(error)));
    }

    stop() {
      this.cancelled = true;
      this.finish();
      frappe.show_alert({message: t("Muster stopped. The unsaved form remains under your control."), indicator: "orange"}, 7);
    }

    async returnForApproval() {
      const proposal = this.preview?.proposal;
      const active = window.cur_frm;
      if (active && this.preview && active.doctype === this.preview.doctype) {
        if (["update", "delete"].includes(this.preview.operation)) {
          await active.reload_doc();
        } else {
          const name = active.docname;
          if (frappe.model?.remove_from_locals) frappe.model.remove_from_locals(active.doctype, name);
          if (active.doc) active.doc.__unsaved = 0;
        }
      }
      this.finish();
      if (proposal) frappe.set_route("Form", "Muster Workflow Proposal", proposal);
    }

    confirmSave() {
      if (!this.preview) return;
      frappe.confirm(
        `${t("Allow Muster to save this")} ${html(this.preview.doctype)}?`,
        () => this.save().catch((error) => {
          if (this.preview) this.renderStatus(t("Review before Save"), t("Save stopped. Review the form and try again, or take control."), true);
          this.showStopped(error);
        }),
      );
    }

    requestDeleteInitiation() {
      if (this.preview?.operation !== "delete" || !this.preview.deleteAuthorized || this.deleteInFlight) return;
      const dialog = new frappe.ui.Dialog({
        title: t("Confirm destructive review"),
        fields: [
          {fieldname: "record_name", fieldtype: "Data", label: t("Type the exact record name"), reqd: 1},
          {fieldname: "understand", fieldtype: "Check", label: t("I authorize Muster to use Frappe's visible Delete confirmation for this exact record"), reqd: 1, default: 0},
        ],
        primary_action_label: t("Delete this record visibly"),
        primary_action: async (values) => {
          if (values.record_name !== this.preview.recordName || !values.understand) {
            frappe.msgprint(t("Type the exact record name and acknowledge the destructive boundary."));
            return;
          }
          dialog.disable_primary_action();
          dialog.hide();
          try {
            await this.executeDelete(values.record_name);
          } catch (error) {
            if (this.preview) this.renderStatus(
              t("Deletion stopped safely"),
              t("Do not repeat the deletion. Check the visible Frappe form and the proposal audit record."),
              true,
            );
            this.showStopped(error);
          } finally {
            dialog.enable_primary_action();
          }
        },
      });
      dialog.show();
    }

    async executeDelete(typedRecordName) {
      if (this.preview?.operation !== "delete" || !this.preview.deleteAuthorized) throw new Error(t("Destructive review authority is unavailable."));
      if (this.deleteInFlight) throw new Error(t("This deletion is already in progress."));
      this.deleteInFlight = true;
      let authorizationToken = null;
      let verificationToken = null;
      try {
      this.assertActiveForm();
      const issued = await frappe.call({
        method: "muster.api.mission.issue_attended_delete", type: "POST",
        args: {
          proposal: this.preview.proposal, typed_record_name: typedRecordName,
          confirmed: 1, idempotency_key: frappe.utils.get_random(24),
        },
      });
      const grant = issued.message;
      if (grant?.issued !== true || grant?.executed !== false || grant?.proposal !== this.preview.proposal
        || grant?.doctype !== this.preview.doctype || grant?.record_name !== this.preview.recordName
        || typeof grant?.authorization !== "string" || typeof grant?.authorization_token !== "string") {
        throw new Error(t("The one-time delete authorization could not be verified."));
      }
      authorizationToken = grant.authorization_token;
      this.assertRecordRevision();
      const menu = this.activeFormMenuButton();
      if (!menu) throw new Error(t("The real Frappe form menu is not visible."));
      await this.pointToElement(menu);
      menu.click();
      await this.waitFor(() => Boolean(this.activeDeleteAction()));
      const deleteAction = this.activeDeleteAction();
      if (!deleteAction) throw new Error(t("The real Frappe Delete action is not visible."));
      await this.pointToElement(deleteAction);
      this.deleteReady = true;
      this.renderStatus(
        t("Muster has taken over"),
        t("Opening Frappe's own Delete confirmation…"),
        false,
      );
      const existingDialogs = new Set(this.visibleNativeDialogs());
      deleteAction.click();
      await this.waitFor(() => Boolean(this.nativeDeleteConfirmation(existingDialogs)));
      const confirmation = this.nativeDeleteConfirmation(existingDialogs);
      if (!confirmation) throw new Error(t("Frappe's native Delete confirmation did not appear."));
      const confirmButton = this.nativeDeleteConfirmationButton(confirmation);
      if (!confirmButton) throw new Error(t("Frappe's native Delete confirmation action is unavailable."));
      await this.pointToElement(confirmButton);
      this.renderStatus(t("Muster has taken over"), t("Confirming this exact deletion in Frappe…"), false);
      const consumed = await frappe.call({
        method: "muster.api.mission.consume_attended_delete", type: "POST",
        args: {
          authorization: grant.authorization, authorization_token: authorizationToken,
          confirmed: 1, idempotency_key: frappe.utils.get_random(24),
        },
      });
      authorizationToken = null;
      const consumption = consumed.message;
      if (consumption?.consumed !== true || consumption?.executed !== false
        || consumption?.authorization !== grant.authorization || consumption?.record_name !== this.preview.recordName
        || typeof consumption?.verification_token !== "string") {
        throw new Error(t("The one-time delete authorization could not be consumed."));
      }
      verificationToken = consumption.verification_token;
      confirmButton.click();
      await this.waitFor(() => !this.visibleExactForm() && !attendedElementVisible(confirmation));
      const verified = await frappe.call({
        method: "muster.api.mission.verify_attended_delete_result", type: "POST",
        args: {
          authorization: grant.authorization, verification_token: verificationToken,
          confirmed: 1, idempotency_key: frappe.utils.get_random(24),
        },
      });
      verificationToken = null;
      if (verified.message?.verified !== true || verified.message?.executed !== true
        || verified.message?.record_name !== this.preview.recordName || typeof verified.message?.receipt_hash !== "string") {
        throw new Error(t("Frappe could not verify that the record was deleted."));
      }
      const deletedName = this.preview.recordName;
      this.finish();
      frappe.show_alert({message: `${t("Deleted and verified")}: ${html(deletedName)}`, indicator: "green"}, 10);
      } finally {
        authorizationToken = null;
        verificationToken = null;
        this.deleteInFlight = false;
      }
    }

    visibleNativeDialogs() {
      return [...document.querySelectorAll?.(".modal.show, .modal.in") || []].filter(attendedElementVisible);
    }

    nativeDeleteConfirmation(existingDialogs = new Set()) {
      if (!this.preview) return null;
      const expectedName = this.preview.recordName.toLowerCase();
      return this.visibleNativeDialogs().find((dialog) => {
        if (existingDialogs.has(dialog)) return false;
        const textContent = String(dialog.textContent || "").trim().toLowerCase();
        const title = String(dialog.querySelector?.(".modal-title")?.textContent || "").trim().toLowerCase();
        return (textContent.includes("delete") || title.includes("delete") || textContent.includes(expectedName))
          && Boolean(this.nativeDeleteConfirmationButton(dialog));
      }) || null;
    }

    nativeDeleteConfirmationButton(dialog) {
      const accepted = new Set([t("Yes").trim().toLowerCase(), t("Delete").trim().toLowerCase()]);
      return [...dialog?.querySelectorAll?.("button") || []].find((candidate) =>
        attendedElementVisible(candidate) && accepted.has(String(candidate.textContent || "").trim().toLowerCase())
        && typeof candidate.click === "function"
      ) || null;
    }

    activeFormMenuButton() {
      const form = this.activeForm();
      if (!form) return null;
      const legacyMenu = attendedElement(form.page?.btn_menu);
      if (attendedElementVisible(legacyMenu) && typeof legacyMenu.click === "function") return legacyMenu;
      const root = attendedElement(form.page?.wrapper) || attendedElement(form.wrapper) || attendedElement(form.$wrapper) || document;
      const menus = [...root.querySelectorAll("button.menu-more-button[aria-label='Menu']")].filter((candidate) =>
        attendedElementVisible(candidate) && typeof candidate.click === "function"
      );
      return menus.length === 1 ? menus[0] : null;
    }

    activeDeleteAction() {
      const form = this.activeForm();
      if (!form) return null;
      const legacyMenu = attendedElement(form.page?.menu);
      const visibleMenus = legacyMenu && attendedElementVisible(legacyMenu)
        ? [legacyMenu]
        : [...document.querySelectorAll(".dropdown-menu.show")].filter(attendedElementVisible);
      if (visibleMenus.length !== 1) return null;
      const menu = visibleMenus[0];
      const label = t("Delete").trim().toLowerCase();
      const action = [...menu.querySelectorAll("a, button")].find((candidate) =>
        attendedElementVisible(candidate)
        && String(candidate.querySelector?.(".menu-item-label")?.textContent || candidate.textContent || "").trim().toLowerCase() === label
      );
      return action && typeof action.click === "function" ? action : null;
    }

    async save() {
      this.assertActiveForm();
      if (!this.preview.saveAuthorized) throw new Error(t("Approve this proposal before Muster can Save."));
      this.preview.fields.forEach((field) => {
        if (field.control === "table") return;
        if (String(cur_frm.doc[field.fieldname] ?? "") !== field.value) throw new Error(`${field.label}: ${t("the value changed after review.")}`);
      });
      const preflight = await frappe.call({
        method: "muster.api.mission.preflight_attended_save", type: "POST",
        args: {
          proposal: this.preview.proposal,
          record_name: this.preview.operation === "update" ? this.preview.recordName : "",
          record_revision: this.preview.operation === "update" ? this.preview.recordRevision : "",
          confirmed: 1,
          idempotency_key: frappe.utils.get_random(24),
        },
      });
      if (!savePreflightMatches(preflight.message, this.preview)) throw new Error(t("The reviewed record, fields, or permissions changed. Muster stopped before Save."));
      if (this.preview.operation === "update") this.assertRecordRevision();
      const button = this.overlay?.querySelector("[data-attended-save]");
      if (button) button.disabled = true;
      this.renderStatus(t("Muster has taken over"), t("Saving the approved form…"), false);
      await cur_frm.save();
      const recordName = cur_frm.docname;
      let response;
      try {
        response = await frappe.call({
          method: "muster.api.mission.verify_attended_save", type: "POST",
          args: {proposal: this.preview.proposal, record_name: recordName, confirmed: 1, idempotency_key: frappe.utils.get_random(24)},
        });
        if (response.message?.verified !== true || response.message?.record_name !== recordName) throw new Error(t("Frappe could not verify the saved record."));
      } catch (_error) {
        this.finish();
        frappe.msgprint({
          title: t("Record saved; verification needs attention"), indicator: "orange",
          message: t("Frappe saved the record, but Muster could not complete its reread proof. Do not repeat the Save; review the record and audit evidence."),
        });
        return;
      }
      if (this.preview.submitRequested) {
        this.preview = Object.freeze({
          ...this.preview,
          operation: "update",
          recordName,
          recordRevision: String(cur_frm.doc?.modified || ""),
        });
        this.draftVerified = true;
        this.renderStatus(
          t("Draft saved and verified"),
          t("The document is still a draft. Continue only when you are ready to open Frappe's separate Submit confirmation; Submit may trigger workflow, stock, accounting, or downstream production effects."),
          true,
        );
        return;
      }
      this.finish();
      frappe.show_alert({message: `${t("Saved and verified")}: ${html(recordName)}`, indicator: "green"}, 10);
    }

    async submit() {
      this.assertActiveForm();
      if (!this.draftVerified || !this.preview?.submitRequested || !this.preview.submitAuthorized) {
        throw new Error(t("The reviewed draft is not ready for Submit."));
      }
      const preflight = await frappe.call({
        method: "muster.api.mission.preflight_attended_submit", type: "POST",
        args: {
          proposal: this.preview.proposal,
          record_name: this.preview.recordName,
          record_revision: this.preview.recordRevision,
          confirmed: 1,
          idempotency_key: frappe.utils.get_random(24),
        },
      });
      if (preflight.message?.current !== true || preflight.message?.docstatus !== 0
        || preflight.message?.record_name !== this.preview.recordName) {
        throw new Error(t("The draft changed or Submit permission is no longer available."));
      }
      const root = cur_frm.page?.wrapper || cur_frm.wrapper || cur_frm.$wrapper;
      const submitButton = this.visibleActionByLabel(root, [t("Submit")]);
      if (!submitButton) throw new Error(t("Frappe's native Submit action is not visible."));
      await this.pointToElement(submitButton);
      this.renderStatus(
        t("Human approval required"),
        t("Opening Frappe's own Submit confirmation. Read it and choose the final action yourself."),
        false,
      );
      const existingDialogs = new Set(this.visibleNativeDialogs());
      submitButton.click();
      await this.waitFor(() => this.visibleNativeDialogs().some((dialog) => !existingDialogs.has(dialog)) || Number(cur_frm?.doc?.docstatus) === 1);
      const confirmation = this.visibleNativeDialogs().find((dialog) => !existingDialogs.has(dialog));
      if (confirmation) {
        const confirmButton = [...confirmation.querySelectorAll("button")].find((candidate) =>
          attendedElementVisible(candidate)
          && [t("Yes"), t("Submit")].map((label) => label.trim().toLowerCase()).includes(String(candidate.textContent || "").trim().toLowerCase())
        );
        if (confirmButton) await this.pointToElement(confirmButton);
        this.renderStatus(
          t("Your decision"),
          t("Frappe is waiting for you. Confirm Submit to continue, or cancel to keep the verified draft."),
          false,
        );
      }
      await this.waitFor(() => Number(cur_frm?.doc?.docstatus) === 1, 120_000);
      const verified = await frappe.call({
        method: "muster.api.mission.verify_attended_submit", type: "POST",
        args: {
          proposal: this.preview.proposal,
          record_name: this.preview.recordName,
          confirmed: 1,
          idempotency_key: frappe.utils.get_random(24),
        },
      });
      if (verified.message?.verified !== true || verified.message?.docstatus !== 1
        || typeof verified.message?.proof_hash !== "string") {
        throw new Error(t("Frappe submitted the document, but the evidence receipt could not be sealed."));
      }
      const recordName = this.preview.recordName;
      this.renderLifecycleReceipt(recordName, verified.message.proof_hash);
      this.finish();
      frappe.show_alert({message: `${t("Submitted and verified")}: ${html(recordName)}`, indicator: "green"}, 12);
    }

    renderLifecycleReceipt(recordName, proofHash) {
      document.querySelectorAll("[data-muster-receipt][data-muster-scenario='guided-workflow']").forEach((node) => node.remove());
      const receipt = document.createElement("section");
      receipt.className = "muster-attended-receipt";
      receipt.dataset.musterReceipt = "true";
      receipt.dataset.musterScenario = "guided-workflow";
      receipt.dataset.musterReceiptStatus = "verified";
      receipt.dataset.musterReceiptId = proofHash;
      receipt.innerHTML = `<strong>${html(t("Submitted with human approval"))}</strong><span>${html(`${this.preview.doctype} ${recordName}. ${t("Frappe completed the lifecycle action and Muster reread the submitted record.")}`)}</span>`;
      document.body.appendChild(receipt);
    }

    showStopped(error) {
      frappe.msgprint({
        title: t("Attended work stopped"),
        message: t("Muster stopped safely. Review the visible form and the proposal audit record before trying again."),
        indicator: "red",
      });
    }

    finish() {
      this.overlay?.remove?.();
      this.overlay = null;
      this.preview = null;
      this.lastCursor = null;
      this.deleteReady = false;
      this.deleteInFlight = false;
      this.draftVerified = false;
    }

    delay(milliseconds) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }

    async waitFor(predicate, timeout = 15_000) {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started >= timeout) throw new Error(t("The reviewed Frappe form did not open in time."));
        await this.delay(100);
      }
    }
  }

  class LineageRemediationPreview extends AttendedDeskPreview {
    constructor() {
      super();
      this.plan = null;
      this.action = null;
      this.authorized = false;
      this.receipts = [];
    }

    async start(plan) {
      if (this.plan || !plan || plan.schema_version !== 1 || !Array.isArray(plan.actions) || !plan.actions.length) {
        throw new Error(t("This reviewed correction is unavailable."));
      }
      this.plan = plan;
      this.receipts = [];
      try {
        await this.walkLineage();
        await this.reviewLineage();
        const authorization = await frappe.call({
          method: "muster.api.lineage.authorize", type: "POST",
          args: {plan_id: plan.plan_id, confirmed: 1},
        });
        if (authorization.message?.authorized !== true) throw new Error(t("The correction approval could not be verified."));
        this.authorized = true;
        for (let index = 0; index < plan.actions.length; index += 1) {
          this.action = plan.actions[index];
          const fields = this.action.fields.map((field) => field.control === "table" ? {
            fieldname: field.fieldname, label: field.label, control: "table",
            child_doctype: field.child_doctype, rows: field.rows,
          } : {
            fieldname: field.fieldname, label: field.label, control: field.control,
            value: String(field.value ?? ""),
          });
          const receipt = {
            proposal: `lineage:${plan.plan_id}`,
            objective: t("Correct the reviewed engineering lineage"),
            operation: "update",
            doctype: this.action.doctype,
            record_name: this.action.record_name,
            record_revision: this.action.record_revision,
            fields,
            save_requires_confirmation: true,
            save_authorized: true,
            executed: false,
          };
          await super.start(receipt);
          this.renderStatus(
            `${t("Saving reviewed correction")} ${index + 1}/${plan.actions.length}`,
            `${this.action.doctype} ${this.action.record_name}: ${t("the visible values match the approved repair plan.")}`,
            false,
          );
          await this.delay(Math.max(ATTENDED_ACTION_PACE_MS, 1200));
          await this.save();
        }
        frappe.show_alert({
          message: `${t("Corrected and verified")} ${this.receipts.length} ${t("affected records")}`,
          indicator: "green",
        }, 12);
        this.renderReceipt();
      } finally {
        this.finish();
        this.plan = null;
        this.action = null;
        this.authorized = false;
      }
    }

    async walkLineage() {
      const records = (this.plan?.lineage || []).flatMap((stage) =>
        (stage.records || []).map((record) => ({record, stage})),
      );
      for (let index = 0; index < records.length; index += 1) {
        const {record, stage} = records[index];
        frappe.set_route("Form", stage.doctype, record.name);
        await this.waitFor(() => cur_frm?.doctype === stage.doctype && cur_frm?.docname === record.name, 20_000);
        this.renderStatus(
          `${t("Engineering lineage")} ${index + 1}/${records.length}: ${stage.label}`,
          `${stage.status}. ${stage.summary}`,
          false,
        );
        const form = attendedElement(cur_frm?.wrapper);
        if (attendedElementVisible(form)) {
          await this.pointToElement(form);
        } else {
          await this.delay(Math.max(ATTENDED_ACTION_PACE_MS, 1600));
        }
      }
      this.finish();
    }

    reviewLineage() {
      const stages = this.plan?.lineage || [];
      const rows = stages.map((stage, index) => {
        const records = (stage.records || []).map((record) => html(record.name)).join(", ") || t("No linked record");
        const tone = ["Inconsistent", "Blocked"].includes(stage.status) ? "danger"
          : ["Requires review", "Requires regeneration"].includes(stage.status) ? "warning"
          : stage.status === "Current" ? "success" : "muted";
        return `<li data-lineage-status="${html(tone)}"><b>${index + 1}</b><div><strong>${html(stage.label)}</strong><span>${records}</span><small>${html(`${stage.status}. ${stage.summary}`)}</small></div></li>`;
      }).join("");
      const root = document.createElement("section");
      root.className = "muster-lineage-review";
      root.dataset.musterLineageReview = "true";
      root.innerHTML = `<div class="muster-lineage-review-card"><header><img src="/assets/muster/images/muster-mark.png" alt=""><div><strong>${html(t("Review the complete engineering chain"))}</strong><small>${html(`${stages.length} ${t("stages checked from the live Frappe records. Only the affected records will change.")}`)}</small></div></header><ol>${rows}</ol><footer><button type="button" class="btn btn-default" data-lineage-cancel>${html(t("Cancel"))}</button><button type="button" class="btn btn-primary" data-lineage-approve>${html(t("Approve affected corrections"))}</button></footer></div>`;
      document.body.appendChild(root);
      return new Promise((resolve, reject) => {
        root.querySelector("[data-lineage-approve]")?.addEventListener("click", () => { root.remove(); resolve(); });
        root.querySelector("[data-lineage-cancel]")?.addEventListener("click", () => { root.remove(); reject(new Error(t("The reviewed correction was not approved."))); });
      });
    }

    renderReceipt() {
      const proofs = this.receipts.map((receipt) => receipt.proof_hash).filter(Boolean);
      if (!proofs.length) return;
      const records = [...new Set((this.plan?.actions || []).map((action) => `${action.doctype} ${action.record_name}`))];
      document.querySelectorAll("[data-muster-receipt][data-muster-scenario='revision-escape']").forEach((node) => node.remove());
      const receipt = document.createElement("section");
      receipt.className = "muster-attended-receipt";
      receipt.dataset.musterReceipt = "true";
      receipt.dataset.musterScenario = "revision-escape";
      receipt.dataset.musterReceiptStatus = "verified";
      receipt.dataset.musterReceiptId = proofs.at(-1);
      receipt.innerHTML = `<strong>${html(t("Correction verified"))}</strong><span>${html(`${records.join(" · ")}. ${this.receipts.length} ${t("affected records were saved through Frappe and reread successfully.")}`)}</span>`;
      document.body.appendChild(receipt);
    }

    confirmSave() {
      // The one-use plan approval happens before the sequence starts. Every
      // native Save still has a fresh server preflight and reread proof.
    }

    async save() {
      this.assertActiveForm();
      if (!this.authorized || !this.plan || !this.action) throw new Error(t("The reviewed correction is not authorized."));
      const preflight = await frappe.call({
        method: "muster.api.lineage.preflight", type: "POST",
        args: {plan_id: this.plan.plan_id, action_id: this.action.id},
      });
      if (preflight.message?.current !== true) throw new Error(t("The record changed after review."));
      await cur_frm.save();
      const verified = await frappe.call({
        method: "muster.api.lineage.verify", type: "POST",
        args: {plan_id: this.plan.plan_id, action_id: this.action.id},
      });
      if (verified.message?.verified !== true) throw new Error(t("The saved correction could not be verified."));
      this.receipts.push(verified.message);
      this.finish();
    }
  }

  window.MusterLiveSessionModel = {parsePayload, normalizedEvent, derivePresence, viewModel, attendedReceipt, attendedDeleteReceipt, attendedControlUnavailable, attendedElementVisible, attendedFieldGuidance, attendedActionGuidance, savePreflightMatches, AttendedDeskPreview, LineageRemediationPreview, ATTENDED_ACTION_PACE_MS};
  window.musterLiveSession = window.musterLiveSession || new LiveWorkSession();
  window.musterAttendedPreview = window.musterAttendedPreview || new AttendedDeskPreview();
  window.musterLineagePreview = window.musterLineagePreview || new LineageRemediationPreview();
})();
