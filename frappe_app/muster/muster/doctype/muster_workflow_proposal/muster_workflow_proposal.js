frappe.ui.form.on("Muster Workflow Proposal", {
  refresh(frm) {
    render_proposal(frm);
    if (frm.is_new()) return;
    const canManage = isProposalManager(frm);
    if (frm.doc.status === "Proposed" && canManage) {
      if (canApproveProposal(frm)) frm.add_custom_button(__("Approve proposal"), () => review(frm, "approve"), __("Review"));
      frm.add_custom_button(__("Reject"), () => review(frm, "reject"), __("Review"));
    }
    const destructiveTarget = attendedTarget(frm);
    if (destructiveTarget && attendedOperation(frm) === "delete" && canManage) {
      frm.add_custom_button(__("Open exact target"), () => frappe.set_route("Form", destructiveTarget.doctype, destructiveTarget.recordName), __("Review"));
    }
    if (canPreviewAttendedProposal(frm)) {
      frm.add_custom_button(__("Open form preview"), () => previewInDesk(frm), __("Attended work"));
    }
    if (frm.doc.status === "Approved" && canManage) {
      frm.add_custom_button(__("Create & publish workflow"), () => publishProposal(frm), __("Workflow"));
    }
    if (frm.doc.status === "Published" && frm.doc.published_workflow) {
      frm.add_custom_button(__("Open published workflow"), () => frappe.set_route("Form", "Muster Workflow", frm.doc.published_workflow), __("Workflow"));
    }
    if (canStartPublishedProposal(frm)) {
      frm.add_custom_button(__("Start governed mission"), () => startProposal(frm), __("Mission"));
    }
    frm.dashboard.add_comment(__("Nothing has run. You can open an attended form preview without saving, or approve and publish this as a reusable workflow."), "blue", true);
  },
});

function isProposalManager(frm = null) {
  // Frappe treats Administrator as an authority identity even when the
  // client-side role cache has not materialized System Manager yet.  Keep the
  // visible controls aligned with the server API's explicit Administrator
  // allowance instead of making a fresh/reloaded form appear unreviewable.
  // `frm.perm` is the server-filtered Frappe permission projection and is the
  // most reliable authority signal during a cold Desk reload, before the
  // client role cache is necessarily complete.
  return Boolean(frm?.perm?.some?.((row) => row?.write))
    || currentSessionUser() === "Administrator"
    || ["Muster Administrator", "Muster Automation Manager", "Muster Approver", "System Manager"]
      .some((role) => frappe.user.has_role(role));
}

function currentSessionUser() {
  return frappe.session?.user
    || (typeof frappe.boot?.user === "string" ? frappe.boot.user : null)
    || frappe.boot?.user?.name
    || frappe.boot?.user?.email
    || frappe.user?.name
    || "Guest";
}

function render_proposal(frm) {
  const target = frm.fields_dict.proposal_preview?.$wrapper?.empty();
  if (!target || !frm.doc.descriptor_json) return;
  let proposal;
  try { proposal = JSON.parse(frm.doc.descriptor_json); } catch { return; }
  const escape = frappe.utils.escape_html;
  const render_step = (step) => {
    const children = step.steps || step.branches || step.subagents || [];
    return `<li><strong>${escape(step.label || __("Work step"))}</strong>${children.length ? `<ol>${children.map(render_step).join("")}</ol>` : ""}</li>`;
  };
  target.html(`<div class="muster-proposal-preview">
    <p>${escape(proposal.meta?.description || "")}</p>
    <ol class="muster-proposal-steps">${(proposal.steps || []).map(render_step).join("")}</ol>
    <p class="text-muted">${__("Review only. Nothing changes in Frappe until you explicitly approve a Save or start a published workflow.")}</p>
  </div>`);
  renderReviewedContext(frm);
}

function renderReviewedContext(frm) {
  const target = frm.fields_dict.context_preview?.$wrapper?.empty();
  if (!target) return;
  try {
    const graph = JSON.parse(frm.doc.compiled_graph_json || "{}");
    const plans = (graph.nodes || []).flatMap((node) => node?.executionIntent?.plan?.attendedCrud ? [node.executionIntent.plan.attendedCrud] : []);
    const plan = plans.length === 1 ? plans[0] : null;
    if (!plan) {
      target.html(`<div class="muster-proposal-preview"><strong>${__("Permission-filtered review")}</strong><p class="text-muted">${__("Muster used only the current user's live site permissions to prepare this proposal.")}</p></div>`);
      return;
    }
    const fieldCount = Array.isArray(plan.fields) ? plan.fields.length : 0;
    const action = plan.operation === "update" ? __("Update") : plan.operation === "delete" ? __("Delete") : __("Create");
    const detail = plan.operation === "delete"
      ? `${__("Exact record")}: ${frappe.utils.escape_html(plan.record_name || __("Unavailable"))}. ${__("A different authorized reviewer must approve this exact revision. Muster then requires the requester to type the exact name before one visible native Frappe deletion.")}`
      : `${__("Reviewed fields")}: ${fieldCount}`;
    target.html(`<div class="muster-proposal-preview"><strong>${frappe.utils.escape_html(action)} ${frappe.utils.escape_html(plan.doctype || __("record"))}</strong><p>${detail}</p><p class="text-muted">${__("Live permissions and the effective form schema will be checked again before attended work. Internal IDs and runtime diagnostics stay in the audit record, not this review screen.")}</p></div>`);
  } catch {
    target.html(`<div class="muster-proposal-preview"><strong>${__("Permission-filtered review")}</strong><p class="text-muted">${__("The reviewed context could not be displayed. Nothing has run.")}</p></div>`);
  }
}

function canPreviewAttendedProposal(frm) {
  if (!["Proposed", "Approved"].includes(frm.doc.status) || frm.doc.requested_by !== currentSessionUser()) return false;
  try {
    const graph = JSON.parse(frm.doc.compiled_graph_json || "{}");
    const attended = (graph.nodes || []).filter((node) => node?.executionIntent?.surface === "browser" && ["create", "update", "delete"].includes(node.executionIntent?.plan?.attendedCrud?.operation));
    return attended.length === 1;
  } catch {
    return false;
  }
}

function previewInDesk(frm) {
  const destructive = attendedOperation(frm) === "delete";
  const dialog = new frappe.ui.Dialog({
    title: destructive ? __("Open destructive review") : __("Open attended form preview"),
    fields: [{fieldname: "summary", fieldtype: "HTML", options: destructive
      ? `<p>${__("Muster will open the exact real record and pause without changing it.")}</p><p class="text-muted">${__("After independent approval, typing the exact record name authorizes one short-lived attempt through Frappe's visible native Delete confirmation. Muster verifies absence and records a receipt afterward.")}</p>`
      : `<p>${__("Muster will open the actual Frappe form and fill only the reviewed fields.")}</p><p class="text-muted">${__("It will pause before Save so you can inspect every value or take control.")}</p>`}],
    primary_action_label: destructive ? __("Open exact record") : __("Open form and fill"),
    async primary_action() {
      dialog.disable_primary_action();
      try {
        const result = await frappe.call({
          method: "muster.api.mission.prepare_attended_preview", type: "POST",
          args: {proposal: frm.doc.name, confirmed: 1, idempotency_key: frappe.utils.get_random(24)},
        });
        if (!window.musterSurfaceAdapters?.start) throw new Error(__("The attended application surface is unavailable."));
        dialog.hide();
        await window.musterSurfaceAdapters.start(result.message);
      } finally {
        dialog.enable_primary_action();
      }
    },
  });
  dialog.show();
}

function attendedOperation(frm) {
  try {
    const graph = JSON.parse(frm.doc.compiled_graph_json || "{}");
    const operations = (graph.nodes || []).flatMap((node) => node?.executionIntent?.plan?.attendedCrud?.operation ? [node.executionIntent.plan.attendedCrud.operation] : []);
    return operations.length === 1 ? operations[0] : null;
  } catch {
    return null;
  }
}

function attendedTarget(frm) {
  try {
    const graph = JSON.parse(frm.doc.compiled_graph_json || "{}");
    const bindings = (graph.nodes || []).flatMap((node) => node?.executionIntent?.plan?.attendedCrud ? [node.executionIntent.plan.attendedCrud] : []);
    if (bindings.length !== 1) return null;
    const binding = bindings[0];
    if (typeof binding.doctype !== "string" || !binding.doctype.trim() || binding.doctype.length > 140
      || typeof binding.record_name !== "string" || !binding.record_name.trim() || binding.record_name.length > 500
      || /[\u0000-\u001f\u007f]/.test(`${binding.doctype}${binding.record_name}`)) return null;
    return Object.freeze({doctype: binding.doctype, recordName: binding.record_name});
  } catch {
    return null;
  }
}

function canApproveProposal(frm) {
  if (frm.doc.status !== "Proposed") return false;
  const operation = attendedOperation(frm);
  if (["update", "delete"].includes(operation) && frm.doc.requested_by === currentSessionUser()) return false;
  if (operation !== "delete") return true;
  const destructiveRole = ["Muster Administrator", "Muster Approver", "System Manager"].some((role) => frappe.user.has_role(role));
  return destructiveRole;
}

function canStartPublishedProposal(frm) {
  const creatorRole = ["Muster Administrator", "Muster Automation Manager", "Muster Operator", "System Manager"]
    .some((role) => frappe.user.has_role(role));
  return Boolean(
    creatorRole
    && frm.doc.status === "Published"
    && frm.doc.published_workflow
    && frm.doc.published_version
    && frm.doc.requested_by === currentSessionUser()
  );
}

async function review(frm, action) {
  await frappe.call({
    method: "muster.api.mission.review_proposal",
    type: "POST",
    args: {proposal: frm.doc.name, action, idempotency_key: frappe.utils.get_random(24)},
    freeze: true,
  });
  await frm.reload_doc();
}

function publishProposal(frm) {
  const dialog = new frappe.ui.Dialog({
    title: __("Publish governed workflow"),
    fields: [
      {fieldname: "root_agent", fieldtype: "Link", options: "Muster Agent", label: __("Root agent"), reqd: 1,
        get_query: () => ({filters: {status: "Active"}})},
      {fieldname: "policy", fieldtype: "Link", options: "Muster Policy", label: __("Policy"), reqd: 1,
        get_query: () => ({filters: {enabled: 1}})},
      {fieldname: "notice", fieldtype: "HTML", options: `<p class="text-muted">${__("This creates a native draft, validates it against current RBAC, and publishes an immutable version. It does not start a mission or perform any business change.")}</p>`},
    ],
    primary_action_label: __("Create & publish"),
    async primary_action(values) {
      dialog.disable_primary_action();
      try {
        const result = await frappe.call({
          method: "muster.api.mission.publish_proposal", type: "POST",
          args: {...values, proposal: frm.doc.name, idempotency_key: frappe.utils.get_random(24)},
          freeze: true,
        });
        dialog.hide();
        await frm.reload_doc();
        frappe.show_alert({message: `${__("Published workflow")}: ${frappe.utils.escape_html(result.message.workflow)}`, indicator: "green"}, 8);
      } finally {
        dialog.enable_primary_action();
      }
    },
  });
  dialog.show();
}

function startProposal(frm) {
  const dialog = new frappe.ui.Dialog({
    title: __("Start governed mission"),
    fields: [
      {fieldname: "summary", fieldtype: "HTML", options: `<p>${__("Muster will create a mission pinned to the reviewed, immutable workflow version.")}</p><p class="text-muted">${__("Current RBAC, policy, agent availability, and evidence hashes are checked again before any work is queued.")}</p>`},
      {fieldname: "confirm_start", fieldtype: "Check", label: __("I confirm that Muster may start this mission"), reqd: 1, default: 0},
    ],
    primary_action_label: __("Start mission"),
    async primary_action(values) {
      if (!values.confirm_start) {
        frappe.msgprint(__("Confirm Start before queueing the mission."));
        return;
      }
      dialog.disable_primary_action();
      try {
        const result = await frappe.call({
          method: "muster.api.mission.start_proposal", type: "POST",
          args: {
            proposal: frm.doc.name,
            confirmed: 1,
            idempotency_key: frappe.utils.get_random(24),
          },
          freeze: true,
        });
        dialog.hide();
        frappe.set_route("Form", "Muster Mission", result.message.mission);
      } finally {
        dialog.enable_primary_action();
      }
    },
  });
  dialog.show();
}

if (typeof window !== "undefined") {
  window.MusterWorkflowProposalUI = Object.freeze({currentSessionUser, isProposalManager, attendedOperation, attendedTarget, canApproveProposal, canPreviewAttendedProposal, previewInDesk, canStartPublishedProposal, startProposal});
}
