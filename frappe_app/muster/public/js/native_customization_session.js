(() => {
  "use strict";

  const SUPPORTED = new Set([
    "custom_field", "property_setter", "doctype", "query_report", "script_report",
    "print_format", "page", "web_page", "client_script", "server_script", "email_template",
  ]);
  const FIELD_TYPES = new Set([
    "Data", "Small Text", "Long Text", "Text", "Text Editor", "Code", "Check", "Int",
    "Float", "Currency", "Percent", "Select", "Link", "Dynamic Link", "Icon", "Color",
    "Date", "Datetime", "Time", "Table", "Table MultiSelect",
  ]);
  const PACE_MS = 650;
  const requiresFullFormBypass = (kind, doctype) => kind === "doctype" || doctype === "DocType";
  const text = (value, maximum = 500) => {
    if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid attended customization evidence.");
    return value;
  };
  const escapeHtml = (value) => window.frappe?.utils?.escape_html
    ? frappe.utils.escape_html(String(value ?? ""))
    : String(value ?? "").replace(/[&<>"']/g, (character) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"})[character]);
  const translate = (value) => typeof window.__ === "function" ? __(value) : value;
  const normalized = (value) => Array.isArray(value)
    ? value.map(normalized)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]))
      : value;
  const stable = (value) => JSON.stringify(normalized(value));

  function projection(value, expectedOperation = null) {
    if (!value || typeof value !== "object" || value.schema_version !== 1 || value.executed !== false) throw new Error(translate("Muster could not verify this customization review."));
    if (!SUPPORTED.has(value.artifact_kind) || !["create", "update", "rollback"].includes(value.operation)) throw new Error(translate("Muster could not verify this customization review."));
    if (expectedOperation && value.operation !== expectedOperation) throw new Error(translate("Muster could not verify this customization review."));
    if (typeof value.apply_authorized !== "boolean" || !/^[a-f0-9]{64}$/.test(value.plan_hash)) throw new Error(translate("Muster could not verify this customization review."));
    const citations = Array.isArray(value.source_citations) ? value.source_citations.map((citation) => {
      if (!citation || typeof citation !== "object" || !/^R[0-9]{3}$/.test(citation.requirement_id)
        || citation.file_id !== text(citation.file_id, 140) || citation.locator !== text(citation.locator, 160)
        || !/^[a-f0-9]{64}$/.test(citation.quote_hash)) throw new Error(translate("Muster could not verify this customization citation."));
      return Object.freeze({...citation});
    }) : [];
    const fields = Array.isArray(value.fields) ? value.fields.map((field) => {
      if (!field || typeof field !== "object" || !FIELD_TYPES.has(field.fieldtype)) throw new Error(translate("Muster could not verify this customization field."));
      return Object.freeze({
        fieldname: text(field.fieldname, 140), label: text(field.label, 140),
        fieldtype: field.fieldtype, value: field.value,
      });
    }) : [];
    if (value.operation !== "rollback" && !fields.length) throw new Error(translate("Muster could not verify this customization review."));
    return Object.freeze({
      changeSet: text(value.change_set, 140), planHash: value.plan_hash,
      operation: value.operation, kind: value.artifact_kind,
      doctype: text(value.doctype, 140), documentName: text(value.document_name, 140),
      approvalClass: text(value.approval_class, 40), applyAuthorized: value.apply_authorized,
      sourceEvidenceHash: value.source_evidence_hash || null,
      citations: Object.freeze(citations), fields: Object.freeze(fields),
    });
  }

  function projectedValue(field, actual) {
    if (!["Table", "Table MultiSelect"].includes(field.fieldtype)) return actual;
    if (!Array.isArray(actual) || !Array.isArray(field.value)) return actual;
    return actual.map((row, index) => Object.fromEntries(
      Object.keys(field.value[index] || {}).map((key) => [key, row?.[key]])
    ));
  }

  class NativeCustomizationSession {
    constructor() {
      this.review = null;
      this.overlay = null;
      this.cancelled = false;
      this.cursor = null;
    }

    async start(changeSet) {
      this.finish();
      const response = await frappe.call({
        method: "muster.api.native_builder.prepare_attended", type: "POST",
        args: {change_set: changeSet, confirmed: 1},
      });
      this.review = projection(response.message);
      this.cancelled = false;
      this.render(translate("Muster has taken over"), translate("Opening the real native customization form…"), false);
      // DocType has a framework Quick Entry dialog. That dialog does not expose
      // the full fields/permissions tables required by a reviewed custom
      // DocType plan, so open the real unsaved Form route directly.
      if (requiresFullFormBypass(this.review.kind, this.review.doctype)) {
        await frappe.model.with_doctype(this.review.doctype);
        const document = frappe.model.get_new_doc(this.review.doctype);
        frappe.set_route("Form", this.review.doctype, document.name);
      } else {
        await frappe.new_doc(this.review.doctype);
      }
      await this.waitFor(() => Boolean(this.activeForm()));
      await this.fillForm();
      this.render(
        translate("Review before Apply"),
        this.review.applyAuthorized
          ? translate("The form is filled from the source-bound plan. Applying will use the approved native Change Set, not this unsaved browser copy.")
          : translate("The form is filled for review. Return to the Change Set for an independent approval."),
        true,
      );
    }

    async startRollback(changeSet) {
      this.finish();
      const response = await frappe.call({
        method: "muster.api.native_builder.prepare_attended_rollback", type: "POST",
        args: {change_set: changeSet, confirmed: 1},
      });
      this.review = projection(response.message, "rollback");
      this.cancelled = false;
      frappe.set_route("Form", this.review.doctype, this.review.documentName);
      await this.waitFor(() => Boolean(this.activeSavedForm()));
      await this.pointTo(this.activeSavedForm().page?.wrapper || this.activeSavedForm().wrapper);
      this.render(
        translate("Review before Rollback"),
        this.review.applyAuthorized
          ? translate("A separate Destructive approval is bound to this exact source and plan.")
          : translate("Rollback is locked until a different approver grants Destructive approval."),
        true,
      );
    }

    activeForm() {
      const form = window.cur_frm;
      const route = frappe.get_route?.() || [];
      return form && route[0] === "Form" && route[1] === this.review?.doctype
        && (form.doc?.__islocal || form.doc?.__unsaved) ? form : null;
    }

    activeSavedForm() {
      const form = window.cur_frm;
      const route = frappe.get_route?.() || [];
      return form && route[0] === "Form" && route[1] === this.review?.doctype
        && form.docname === this.review?.documentName && !form.doc?.__islocal ? form : null;
    }

    async fillForm() {
      const form = this.activeForm();
      if (!form) throw new Error(translate("The real native customization form is not active."));
      for (const field of this.review.fields) {
        if (this.cancelled) throw new Error(translate("Muster stopped before applying changes."));
        const control = form.fields_dict?.[field.fieldname];
        if (!control) throw new Error(`${field.label}: ${translate("the native form field is unavailable.")}`);
        await this.pointTo(control.$wrapper || control.wrapper);
        if (["Table", "Table MultiSelect"].includes(field.fieldtype)) {
          frappe.model.clear_table(form.doc, field.fieldname);
          (Array.isArray(field.value) ? field.value : []).forEach((row) => form.add_child(field.fieldname, row));
          form.refresh_field(field.fieldname);
        } else {
          await form.set_value(field.fieldname, field.value);
        }
        await this.delay(PACE_MS);
      }
    }

    assertUnchanged() {
      const form = this.activeForm();
      if (!form) throw new Error(translate("The real native customization form is no longer active."));
      this.review.fields.forEach((field) => {
        const actual = projectedValue(field, form.doc?.[field.fieldname]);
        if (stable(actual) !== stable(field.value)) throw new Error(`${field.label}: ${translate("the reviewed value changed.")}`);
      });
    }

    async apply() {
      this.assertUnchanged();
      if (!this.review.applyAuthorized) throw new Error(translate("Independent approval is required before Apply."));
      this.render(translate("Muster has taken over"), translate("Applying the exact approved native Change Set…"), false);
      const response = await frappe.call({
        method: "muster.api.native_builder.apply_attended", type: "POST",
        args: {change_set: this.review.changeSet, confirmed: 1},
      });
      if (response.message?.status !== "Verified" || response.message?.plan_hash !== this.review.planHash) throw new Error(translate("The native apply receipt did not match this review."));
      frappe.set_route("Form", this.review.doctype, this.review.documentName);
      await this.waitFor(() => Boolean(this.activeSavedForm()));
      const verified = await frappe.call({
        method: "muster.api.native_builder.verify_attended", type: "POST",
        args: {change_set: this.review.changeSet},
      });
      if (verified.message?.verified !== true || verified.message?.artifacts?.[0]?.name !== this.review.documentName) throw new Error(translate("Independent native reread verification failed."));
      const name = this.review.documentName;
      this.finish();
      frappe.show_alert({message: `${translate("Applied and verified")}: ${escapeHtml(name)}`, indicator: "green"}, 10);
    }

    async rollback() {
      if (this.review?.operation !== "rollback" || !this.review.applyAuthorized) throw new Error(translate("Destructive rollback approval is unavailable."));
      this.render(translate("Muster has taken over"), translate("Rolling back the exact verified native Change Set…"), false);
      const response = await frappe.call({
        method: "muster.api.native_builder.rollback_attended", type: "POST",
        args: {change_set: this.review.changeSet, confirmed: 1},
      });
      if (response.message?.status !== "Rolled Back") throw new Error(translate("Rollback did not return verified repair evidence."));
      const verified = await frappe.call({
        method: "muster.api.native_builder.verify_attended_rollback", type: "POST",
        args: {change_set: this.review.changeSet},
      });
      if (verified.message?.verified !== true) throw new Error(translate("Independent rollback verification failed."));
      this.finish();
      frappe.set_route("Form", "Muster Change Set", response.message?.execution_id || this.review?.changeSet);
      frappe.show_alert({message: translate("Rollback independently verified"), indicator: "green"}, 10);
    }

    render(title, detail, waiting) {
      if (!this.overlay) {
        this.overlay = document.createElement("section");
        this.overlay.className = "muster-attended-overlay muster-native-customization-overlay";
        this.overlay.setAttribute("role", "status");
        document.body.appendChild(this.overlay);
      }
      const citations = this.review?.citations?.map((item) => `${item.requirement_id} · ${item.locator}`).join("; ") || translate("No uploaded source");
      const actions = waiting
        ? `<button type="button" class="btn btn-sm btn-default" data-native-stop>${escapeHtml(translate("Take control"))}</button>${this.review?.applyAuthorized
          ? `<button type="button" class="btn btn-sm ${this.review.operation === "rollback" ? "btn-danger" : "btn-primary"}" data-native-commit>${escapeHtml(translate(this.review.operation === "rollback" ? "Approve Rollback" : "Approve Apply"))}</button>`
          : `<a class="btn btn-sm btn-primary" href="/desk/muster-change-set/${encodeURIComponent(this.review?.changeSet || "")}">${escapeHtml(translate("Return for approval"))}</a>`}`
        : "";
      const label = waiting ? translate("Muster paused here") : translate("Muster has taken over");
      this.overlay.innerHTML = `<div class="muster-attended-banner"><img src="/assets/muster/images/muster-mark.png" alt=""><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small><small>${escapeHtml(citations)}</small></div>${actions}</div><div class="muster-attended-cursor" data-native-cursor aria-label="${escapeHtml(label)}"><i></i><span>${escapeHtml(label)}</span></div>`;
      this.applyCursor();
      this.overlay.querySelector("[data-native-stop]")?.addEventListener("click", () => this.stop());
      this.overlay.querySelector("[data-native-commit]")?.addEventListener("click", () => {
        frappe.confirm(
          this.review.operation === "rollback" ? translate("Roll back this exact approved Change Set?") : translate("Apply this exact approved Change Set?"),
          () => (this.review.operation === "rollback" ? this.rollback() : this.apply()).catch(() => this.render(translate("Stopped safely"), translate("Review the Change Set audit before retrying."), true)),
        );
      });
    }

    async pointTo(value) {
      const element = value?.nodeType === 1 ? value : value?.[0];
      if (!element?.getBoundingClientRect) throw new Error(translate("The real native form control is not visible."));
      element.scrollIntoView?.({behavior: "smooth", block: "center"});
      const rectangle = element.getBoundingClientRect();
      this.cursor = {x: `${Math.max(12, rectangle.left + rectangle.width * .72)}px`, y: `${Math.max(70, rectangle.top + rectangle.height * .5)}px`};
      this.applyCursor();
      await this.delay(PACE_MS);
    }

    applyCursor() {
      const cursor = this.overlay?.querySelector("[data-native-cursor]");
      if (cursor && this.cursor) {
        cursor.style.setProperty("--attended-x", this.cursor.x);
        cursor.style.setProperty("--attended-y", this.cursor.y);
      }
    }

    stop() {
      this.cancelled = true;
      this.finish();
      frappe.show_alert({message: translate("Muster stopped. The unsaved native form remains under your control."), indicator: "orange"}, 8);
    }

    finish() {
      this.overlay?.remove?.();
      this.overlay = null;
      this.review = null;
      this.cursor = null;
      this.cancelled = false;
    }

    delay(milliseconds) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }
    async waitFor(predicate, timeout = 15000) {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error(translate("The native customization form did not open in time."));
        await this.delay(100);
      }
    }
  }

  window.MusterNativeCustomizationModel = {
    projection, projectedValue, requiresFullFormBypass, SUPPORTED, FIELD_TYPES,
  };
  window.musterNativeCustomization = window.musterNativeCustomization || new NativeCustomizationSession();
})();
