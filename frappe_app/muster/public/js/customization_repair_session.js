(() => {
  "use strict";

  const SCENARIO = "authorized-customization-repair";
  const DEMO_PROMPT = "why this error coming? i did everything correctly. please check and fix";
  const HASH = /^[a-f0-9]{64}$/;
  const TOKEN = /^[A-Za-z0-9_-]{40,256}$/;
  const RETEST_STORAGE = "muster:customization-repair:retest:v1";
  const translate = (value) => typeof window.__ === "function" ? __(value) : value;
  const escapeHtml = (value) => window.frappe?.utils?.escape_html
    ? frappe.utils.escape_html(String(value ?? ""))
    : String(value ?? "").replace(/[&<>"']/g, (character) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"})[character]);

  function requiredText(value, label, maximum = 2000) {
    if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw new Error(`${label}: ${translate("the server evidence is invalid.")}`);
    }
    return value;
  }

  function diagnosisProjection(value) {
    if (!value || typeof value !== "object" || value.schema_version !== 1
      || value.executed !== false || value.approval_required !== true
      || !TOKEN.test(value.preview || "") || !HASH.test(value.before_hash || "")
      || !HASH.test(value.after_hash || "") || value.before_hash === value.after_hash) {
      throw new Error(translate("Muster could not verify this Client Script diagnosis."));
    }
    const explanation = value.business_explanation;
    const schema = value.schema;
    if (!explanation || typeof explanation !== "object" || !schema || typeof schema !== "object"
      || !HASH.test(schema.schema_hash || "")) {
      throw new Error(translate("Muster could not verify the affected form evidence."));
    }
    return Object.freeze({
      preview: value.preview,
      clientScript: requiredText(value.client_script, "Client Script", 140),
      targetDoctype: requiredText(value.target_doctype, "Affected form", 140),
      view: requiredText(value.view, "View", 80),
      beforeHash: value.before_hash,
      afterHash: value.after_hash,
      diff: requiredText(value.diff, "Reviewed diff", 300000),
      schemaHash: schema.schema_hash,
      schemaRevision: requiredText(schema.revision, "Schema revision", 200),
      summary: requiredText(explanation.summary, "Business summary"),
      reason: requiredText(explanation.reason, "Business reason"),
      refreshRequired: explanation.requires_browser_refresh === true,
    });
  }

  function injectStyle() {
    if (document.querySelector("style[data-muster-repair-style]")) return;
    const style = document.createElement("style");
    style.dataset.musterRepairStyle = "true";
    style.textContent = `
      .muster-repair-session{position:fixed;z-index:1065;right:24px;bottom:24px;width:min(520px,calc(100vw - 32px));max-height:min(760px,calc(100vh - 40px));overflow:auto;background:#fff;color:#17212b;border:1px solid #d7e5e3;border-radius:8px;box-shadow:0 18px 60px rgba(18,51,48,.22);font-family:var(--font-stack,Inter,sans-serif)}
      .muster-repair-session *{box-sizing:border-box}.muster-repair-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px;border-bottom:1px solid #e7efee;background:#f6fbfa}.muster-repair-mark{width:30px;height:30px;object-fit:contain}.muster-repair-head div{flex:1}.muster-repair-head strong{display:block;font-size:15px;color:#123b37}.muster-repair-head small{display:block;margin-top:3px;color:#60726f;line-height:1.4}.muster-repair-state{font-size:11px;font-weight:700;text-transform:uppercase;color:#087e72;background:#dff5f1;border-radius:4px;padding:4px 7px;white-space:nowrap}
      .muster-repair-body{padding:16px 18px}.muster-repair-business{border-left:3px solid #15a594;padding:2px 0 2px 12px;margin-bottom:14px}.muster-repair-business h4{font-size:14px;margin:0 0 6px}.muster-repair-business p{font-size:13px;line-height:1.5;margin:4px 0;color:#40514f}.muster-repair-proof{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}.muster-repair-proof div{padding:9px;background:#f6f8f8;border:1px solid #e1e8e7;border-radius:5px;min-width:0}.muster-repair-proof small{display:block;color:#6a7977}.muster-repair-proof code{display:block;overflow:hidden;text-overflow:ellipsis;color:#173c38;font-size:11px;margin-top:4px}.muster-repair-diff{margin:12px 0;border:1px solid #dfe7e6;border-radius:5px;overflow:hidden}.muster-repair-diff summary{cursor:pointer;padding:9px 11px;background:#f4f7f7;font-size:12px;font-weight:650}.muster-repair-diff pre{margin:0;padding:12px;max-height:220px;overflow:auto;background:#111817;color:#d8ebe8;font-size:11px;line-height:1.45;white-space:pre-wrap}.muster-repair-note{font-size:12px;line-height:1.45;color:#526461;margin:10px 0}.muster-repair-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:12px 18px;border-top:1px solid #e7efee}.muster-repair-actions button{border-radius:5px}.muster-repair-error{color:#9c2c2c;background:#fff2f2;border:1px solid #f2caca;padding:10px;border-radius:5px;font-size:12px}.muster-repair-success{color:#155e42;background:#ebfaf3;border:1px solid #bfead4;padding:10px;border-radius:5px;font-size:12px;font-weight:650}
      @media(max-width:600px){.muster-repair-session{right:12px;bottom:12px;width:calc(100vw - 24px)}.muster-repair-proof{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  class CustomizationRepairSession {
    constructor() {
      this.root = null;
      this.review = null;
      this.applyReceipt = null;
      this.rollbackReview = null;
      this.busy = false;
      this.retestReceipt = null;
      this.resumeRetest();
    }

    checkpoint(name, evidence = {}) {
      if (this.root) {
        this.root.dataset.musterCheckpoint = name;
        this.root.dataset.musterScenario = SCENARIO;
        this.root.dataset.musterEvidence = "true";
      }
      window.dispatchEvent(new CustomEvent("muster:customization-repair-checkpoint", {
        detail: Object.freeze({scenario: SCENARIO, checkpoint: name, ...evidence}),
      }));
    }

    async diagnose({clientScript, proposedScript, businessReason}) {
      const response = await frappe.call({
        method: "muster.api.customization_repair.diagnose_client_script",
        type: "POST",
        args: {client_script: clientScript, proposed_script: proposedScript, business_reason: businessReason},
        freeze: false,
      });
      return this.start(response.message);
    }

    async diagnosePrevious({clientScript, businessReason, version = ""}) {
      const response = await frappe.call({
        method: "muster.api.customization_repair.diagnose_previous_client_script_version",
        type: "POST",
        args: {client_script: clientScript, business_reason: businessReason, version},
        freeze: false,
      });
      const launch = response.message?.launch_receipt;
      if (!launch || launch.schema_version !== 1 || launch.source !== "Frappe Version"
        || launch.current_source_verified !== true || launch.generated_source !== false
        || !HASH.test(launch.live_hash || "") || !HASH.test(launch.proposed_hash || "")
        || !requiredText(launch.version, "Version", 140)) {
        throw new Error(translate("Muster could not verify the prior Client Script Version."));
      }
      const review = this.start(response.message);
      this.root.dataset.musterLaunchReceipt = launch.version;
      this.checkpoint("version-source-verified", {version: launch.version, liveHash: launch.live_hash, proposedHash: launch.proposed_hash});
      window.setTimeout(() => this.checkpoint("approval-required", {afterHash: review.afterHash, version: launch.version}), 0);
      return review;
    }

    start(diagnosis) {
      this.finish();
      this.review = diagnosisProjection(diagnosis);
      injectStyle();
      this.root = document.createElement("section");
      this.root.className = "muster-repair-session muster-attended-overlay";
      this.root.setAttribute("role", "dialog");
      this.root.setAttribute("aria-label", translate("Reviewed customization repair"));
      this.root.setAttribute("data-muster-takeover", "true");
      this.root.setAttribute("data-muster-takeover-state", "waiting");
      this.root.setAttribute("data-waiting", "true");
      document.body.appendChild(this.root);
      this.renderReview();
      this.checkpoint("diagnosis-visible", {beforeHash: this.review.beforeHash, afterHash: this.review.afterHash});
      window.setTimeout(() => this.checkpoint("approval-required", {afterHash: this.review.afterHash}), 0);
      return this.review;
    }

    shell(state, body, actions) {
      this.root.innerHTML = `<header class="muster-repair-head"><img class="muster-repair-mark" src="/assets/muster/images/muster-mark.png" alt=""><div><strong>${escapeHtml(translate("Customization diagnosis"))}</strong><small>${escapeHtml(this.review.clientScript)} · ${escapeHtml(this.review.targetDoctype)}</small></div><span class="muster-repair-state">${escapeHtml(state)}</span></header><div class="muster-repair-body">${body}</div><footer class="muster-repair-actions">${actions}</footer>`;
      this.bind();
    }

    reviewBody(diff = this.review.diff, rollback = false) {
      const title = rollback ? translate("Restoration plan") : translate("What is happening in the business flow");
      const summary = rollback
        ? translate("This restores the exact Client Script version captured before the repair. Any later administrator change blocks automatic restoration.")
        : this.review.summary;
      return `<div class="muster-repair-business"><h4>${escapeHtml(title)}</h4><p>${escapeHtml(this.review.reason)}</p><p>${escapeHtml(summary)}</p></div><div class="muster-repair-proof"><div><small>${escapeHtml(rollback ? translate("Current repaired version") : translate("Current version"))}</small><code>${escapeHtml(rollback ? this.rollbackReview.currentHash : this.review.beforeHash)}</code></div><div><small>${escapeHtml(rollback ? translate("Version to restore") : translate("Reviewed repair"))}</small><code>${escapeHtml(rollback ? this.rollbackReview.restoreHash : this.review.afterHash)}</code></div><div><small>${escapeHtml(translate("Live form schema"))}</small><code>${escapeHtml(this.review.schemaHash)}</code></div><div><small>${escapeHtml(translate("Affected screen"))}</small><code>${escapeHtml(`${this.review.targetDoctype} · ${this.review.view}`)}</code></div></div><details class="muster-repair-diff" open data-muster-review><summary>${escapeHtml(rollback ? translate("Exact rollback diff") : translate("Exact reviewed diff"))}</summary><pre>${escapeHtml(diff)}</pre></details><p class="muster-repair-note">${escapeHtml(rollback ? translate("Rollback also requires explicit approval and an independent server reread.") : translate("Nothing has changed yet. Apply is bound to these exact hashes, this user, this site, the live permissions, and the current form schema."))}</p>`;
    }

    renderReview() {
      this.shell(translate("Review"), this.reviewBody(), `<button class="btn btn-sm btn-default" type="button" data-repair-close>${escapeHtml(translate("Cancel"))}</button><button class="btn btn-sm btn-primary" type="button" data-repair-apply data-muster-approve>${escapeHtml(translate("Approve exact repair"))}</button>`);
    }

    async approveApply() {
      if (this.busy) return;
      this.busy = true;
      this.shell(translate("Applying"), `${this.reviewBody()}<p class="muster-repair-note">${escapeHtml(translate("Applying the exact reviewed source, then rereading the saved Client Script…"))}</p>`, "");
      this.checkpoint("apply-started", {afterHash: this.review.afterHash});
      try {
        const authorized = await frappe.call({
          method: "muster.api.customization_repair.authorize_client_script_repair", type: "POST", freeze: false,
          args: {preview: this.review.preview, reviewed_before_hash: this.review.beforeHash, reviewed_after_hash: this.review.afterHash, confirmed: 1},
        });
        const grant = authorized.message;
        if (!grant || grant.authorized !== true || grant.executed !== false || grant.one_use !== true
          || !TOKEN.test(grant.authorization || "") || !TOKEN.test(grant.authorization_token || "")
          || grant.before_hash !== this.review.beforeHash || grant.after_hash !== this.review.afterHash) {
          throw new Error(translate("The repair authorization did not match this review."));
        }
        const applied = await frappe.call({
          method: "muster.api.customization_repair.apply_client_script_repair", type: "POST", freeze: false,
          args: {authorization: grant.authorization, authorization_token: grant.authorization_token, confirmed: 1},
        });
        const receipt = applied.message;
        if (!receipt || receipt.executed !== true || receipt.verified !== true
          || receipt.reviewed_after_hash !== this.review.afterHash
          || receipt.observed_after_hash !== this.review.afterHash
          || receipt.before_hash !== this.review.beforeHash || !TOKEN.test(receipt.receipt || "")
          || !HASH.test(receipt.receipt_hash || "")) {
          throw new Error(translate("The saved Client Script did not match the reviewed repair."));
        }
        this.applyReceipt = receipt;
        this.renderVerified();
        this.checkpoint("apply-verified", {receiptHash: receipt.receipt_hash, observedHash: receipt.observed_after_hash});
      } catch (error) {
        this.renderFailure(error);
        throw error;
      } finally {
        this.busy = false;
      }
    }

    renderVerified() {
      const body = `<div class="muster-repair-success" data-muster-receipt data-muster-scenario="${SCENARIO}" data-muster-receipt-id="${escapeHtml(this.applyReceipt.receipt_hash)}" data-muster-receipt-status="verified">${escapeHtml(translate("The approved Client Script repair was applied and independently verified."))}</div><div class="muster-repair-proof"><div><small>${escapeHtml(translate("Observed version"))}</small><code>${escapeHtml(this.applyReceipt.observed_after_hash)}</code></div><div><small>${escapeHtml(translate("Evidence receipt"))}</small><code>${escapeHtml(this.applyReceipt.receipt_hash)}</code></div></div><p class="muster-repair-note">${escapeHtml(this.review.refreshRequired ? translate("Users should refresh the affected form to load the reviewed browser behavior.") : translate("The reviewed behavior is active."))}</p>`;
      this.shell(translate("Verified"), body, `<button class="btn btn-sm btn-default" type="button" data-repair-close>${escapeHtml(translate("Done"))}</button><button class="btn btn-sm btn-primary" type="button" data-repair-retest>${escapeHtml(translate("Re-test the affected form"))}</button>`);
    }

    prepareRetest() {
      if (!this.review || !this.applyReceipt) return;
      window.sessionStorage.setItem(RETEST_STORAGE, JSON.stringify({
        review: this.review,
        applyReceipt: this.applyReceipt,
        route: `${window.location.pathname}${window.location.search || ""}`,
      }));
      this.checkpoint("business-retest-loading", {receiptHash: this.applyReceipt.receipt_hash});
      window.location.reload();
    }

    resumeRetest() {
      let saved;
      try {
        saved = JSON.parse(window.sessionStorage.getItem(RETEST_STORAGE) || "null");
      } catch (_error) {
        window.sessionStorage.removeItem(RETEST_STORAGE);
        return;
      }
      if (!saved?.review || !saved?.applyReceipt || saved.route !== `${window.location.pathname}${window.location.search || ""}`) return;
      window.setTimeout(() => {
        try {
          this.review = Object.freeze(saved.review);
          this.applyReceipt = Object.freeze(saved.applyReceipt);
          injectStyle();
          this.root = document.createElement("section");
          this.root.className = "muster-repair-session muster-attended-overlay";
          this.root.setAttribute("role", "dialog");
          this.root.setAttribute("data-muster-takeover", "true");
          this.root.setAttribute("data-muster-takeover-state", "retesting");
          document.body.appendChild(this.root);
          const body = `<div class="muster-repair-business"><h4>${escapeHtml(translate("Verify the user action"))}</h4><p>${escapeHtml(translate("The repaired browser rule is loaded. Muster will now repeat the same Save on the live form and stop if the former validation error returns."))}</p></div><p class="muster-repair-note">${escapeHtml(translate("No restoration will start until this business action is proven."))}</p>`;
          this.shell(translate("Re-test"), body, `<button class="btn btn-sm btn-primary" type="button" data-repair-retest-continue>${escapeHtml(translate("Repeat the live Save"))}</button>`);
          this.checkpoint("business-retest-ready", {receiptHash: this.applyReceipt.receipt_hash});
        } catch (_error) {
          window.sessionStorage.removeItem(RETEST_STORAGE);
        }
      }, 500);
    }

    markRetestVerified(evidence) {
      const before = requiredText(evidence?.before_modified, "Prior record revision", 200);
      const after = requiredText(evidence?.after_modified, "Verified record revision", 200);
      if (before === after || evidence?.old_error_absent !== true || evidence?.saved !== true) {
        throw new Error(translate("The affected form Save was not independently proven."));
      }
      this.retestReceipt = Object.freeze({before, after});
      this.root.style.display = "";
      const receiptId = this.applyReceipt.receipt_hash;
      const body = `<div class="muster-repair-success" data-muster-business-retest data-muster-retest-status="verified">${escapeHtml(translate("The same revision-B Save now succeeds. The former validation error did not return."))}</div><div class="muster-repair-proof"><div><small>${escapeHtml(translate("Record before re-test"))}</small><code>${escapeHtml(before)}</code></div><div><small>${escapeHtml(translate("Record after re-test"))}</small><code>${escapeHtml(after)}</code></div></div><p class="muster-repair-note">${escapeHtml(translate("The repaired behavior is now proven at both levels: the saved Client Script source and the live business form."))}</p>`;
      this.shell(translate("Business action verified"), body, `<button class="btn btn-sm btn-default" type="button" data-repair-prepare-rollback>${escapeHtml(translate("Review restoration"))}</button>`);
      this.root.dataset.musterRetestVerified = "true";
      this.checkpoint("business-retest-verified", {receiptHash: receiptId, beforeModified: before, afterModified: after});
    }

    async prepareRollback() {
      if (this.busy || !this.applyReceipt) return;
      this.busy = true;
      try {
        const response = await frappe.call({
          method: "muster.api.customization_repair.prepare_client_script_rollback", type: "POST", freeze: false,
          args: {receipt: this.applyReceipt.receipt},
        });
        const value = response.message;
        if (!value || value.executed !== false || value.approval_required !== true
          || !TOKEN.test(value.rollback_preview || "") || value.current_hash !== this.review.afterHash
          || value.restore_hash !== this.review.beforeHash || typeof value.diff !== "string") {
          throw new Error(translate("Muster could not verify the restoration plan."));
        }
        this.rollbackReview = Object.freeze({preview: value.rollback_preview, currentHash: value.current_hash, restoreHash: value.restore_hash, diff: value.diff});
        this.shell(translate("Rollback review"), this.reviewBody(value.diff, true), `<button class="btn btn-sm btn-default" type="button" data-repair-close>${escapeHtml(translate("Keep repair"))}</button><button class="btn btn-sm btn-danger" type="button" data-repair-rollback data-muster-approve>${escapeHtml(translate("Approve exact rollback"))}</button>`);
        this.checkpoint("rollback-ready", {currentHash: value.current_hash, restoreHash: value.restore_hash});
      } catch (error) {
        this.renderFailure(error);
        throw error;
      } finally {
        this.busy = false;
      }
    }

    async approveRollback() {
      if (this.busy || !this.rollbackReview) return;
      this.busy = true;
      this.shell(translate("Restoring"), `${this.reviewBody(this.rollbackReview.diff, true)}<p class="muster-repair-note">${escapeHtml(translate("Restoring the exact original source, then rereading it from Frappe…"))}</p>`, "");
      try {
        const authorized = await frappe.call({
          method: "muster.api.customization_repair.authorize_client_script_rollback", type: "POST", freeze: false,
          args: {rollback_preview: this.rollbackReview.preview, reviewed_current_hash: this.rollbackReview.currentHash, reviewed_restore_hash: this.rollbackReview.restoreHash, confirmed: 1},
        });
        const grant = authorized.message;
        if (!grant || grant.authorized !== true || grant.one_use !== true
          || !TOKEN.test(grant.authorization || "") || !TOKEN.test(grant.authorization_token || "")
          || grant.current_hash !== this.rollbackReview.currentHash || grant.restore_hash !== this.rollbackReview.restoreHash) {
          throw new Error(translate("The rollback authorization did not match this review."));
        }
        const response = await frappe.call({
          method: "muster.api.customization_repair.rollback_client_script_repair", type: "POST", freeze: false,
          args: {authorization: grant.authorization, authorization_token: grant.authorization_token, confirmed: 1},
        });
        const receipt = response.message;
        if (!receipt || receipt.executed !== true || receipt.verified !== true || receipt.restored !== true
          || receipt.reviewed_restore_hash !== this.review.beforeHash
          || receipt.observed_restore_hash !== this.review.beforeHash || !HASH.test(receipt.receipt_hash || "")) {
          throw new Error(translate("The restored Client Script did not match the original version."));
        }
        const body = `<div class="muster-repair-success" data-muster-receipt data-muster-scenario="${SCENARIO}" data-muster-receipt-id="${escapeHtml(receipt.receipt_hash)}" data-muster-receipt-status="restored">${escapeHtml(translate("Original Client Script restored and independently verified."))}</div><div class="muster-repair-proof"><div><small>${escapeHtml(translate("Observed restored version"))}</small><code>${escapeHtml(receipt.observed_restore_hash)}</code></div><div><small>${escapeHtml(translate("Rollback receipt"))}</small><code>${escapeHtml(receipt.receipt_hash)}</code></div></div>`;
        this.shell(translate("Restored"), body, `<button class="btn btn-sm btn-default" type="button" data-repair-close>${escapeHtml(translate("Done"))}</button>`);
        window.sessionStorage.removeItem(RETEST_STORAGE);
        this.checkpoint("rollback-verified", {receiptHash: receipt.receipt_hash, observedHash: receipt.observed_restore_hash});
      } catch (error) {
        this.renderFailure(error);
        throw error;
      } finally {
        this.busy = false;
      }
    }

    renderFailure(error) {
      const message = error?.message || translate("The repair stopped safely before it could be verified.");
      this.shell(translate("Stopped"), `<div class="muster-repair-error">${escapeHtml(message)}</div><p class="muster-repair-note">${escapeHtml(translate("Do not repeat the action blindly. Prepare a fresh diagnosis from the live Client Script."))}</p>`, `<button class="btn btn-sm btn-default" type="button" data-repair-close>${escapeHtml(translate("Close"))}</button>`);
      this.checkpoint("failed", {message: String(message).slice(0, 240)});
    }

    bind() {
      this.root.querySelector("[data-repair-close]")?.addEventListener("click", () => this.finish());
      this.root.querySelector("[data-repair-prepare-rollback]")?.addEventListener("click", () => this.prepareRollback().catch(() => {}));
      this.root.querySelector("[data-repair-retest]")?.addEventListener("click", () => this.prepareRetest());
      this.root.querySelector("[data-repair-retest-continue]")?.addEventListener("click", () => {
        this.root.style.display = "none";
        this.checkpoint("business-retest-running", {receiptHash: this.applyReceipt?.receipt_hash});
      });
      this.root.querySelector("[data-repair-apply]")?.addEventListener("click", () => frappe.confirm(
        translate("Apply this exact reviewed Client Script repair?"),
        () => this.approveApply().catch(() => {}),
      ));
      this.root.querySelector("[data-repair-rollback]")?.addEventListener("click", () => frappe.confirm(
        translate("Restore the exact Client Script version captured before this repair?"),
        () => this.approveRollback().catch(() => {}),
      ));
    }

    finish() {
      this.root?.remove?.();
      this.root = null;
      this.review = null;
      this.applyReceipt = null;
      this.rollbackReview = null;
      this.retestReceipt = null;
      this.busy = false;
    }
  }

  window.MusterCustomizationRepairModel = Object.freeze({diagnosisProjection, DEMO_PROMPT, SCENARIO});
  window.musterCustomizationRepair = window.musterCustomizationRepair || new CustomizationRepairSession();
})();
