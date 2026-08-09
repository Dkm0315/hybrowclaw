frappe.ui.form.on("Muster Development Proposal", {
  refresh(frm) {
    if (frm.doc.status === "Proposed") {
      frm.add_custom_button(__("Approve"), () => review(frm, "approve"), __("Review"));
      frm.add_custom_button(__("Reject"), () => review(frm, "reject"), __("Review"));
    }
    if (frm.doc.status === "Approved") {
      frm.add_custom_button(__("Generate isolated patch"), () => frappe.confirm(
        __("Run Codex offline in a fresh exported workspace? The registered source will remain unchanged."),
        () => call(frm, "muster.api.development.generate", {proposal: frm.doc.name, confirmed: 1}),
      ));
    }
    if (frm.doc.status === "Ready") {
      frm.add_custom_button(__("Apply reviewed patch"), () => frappe.confirm(
        __("Apply only the exact reviewed patch to the unchanged registered revision? This does not deploy, migrate, build, or restart."),
        () => call(frm, "muster.api.development.apply", {proposal: frm.doc.name, confirmed: 1}),
      ));
    }
    if (frm.doc.status === "Applied" && frm.doc.deployment_status === "Ready for Separate Gate") {
      if (!frm.doc.rollback_status || ["Not Requested", "Rejected"].includes(frm.doc.rollback_status)) {
        frm.add_custom_button(__("Request exact rollback"), () => call(
          frm, "muster.api.development.request_rollback", {proposal: frm.doc.name},
        ), __("Destructive"));
      }
      if (frm.doc.rollback_status === "Pending Review") {
        frm.add_custom_button(__("Approve rollback"), () => call(
          frm, "muster.api.development.review_rollback", {proposal: frm.doc.name, action: "approve"},
        ), __("Destructive"));
        frm.add_custom_button(__("Reject rollback"), () => call(
          frm, "muster.api.development.review_rollback", {proposal: frm.doc.name, action: "reject"},
        ), __("Destructive"));
      }
      if (frm.doc.rollback_status === "Approved") {
        frm.add_custom_button(__("Execute exact rollback"), () => frappe.confirm(
          __("Reverse only the independently approved exact patch? Muster will refuse if any changed file has drifted."),
          () => call(frm, "muster.api.development.rollback", {proposal: frm.doc.name, confirmed: 1}),
        ), __("Destructive"));
      }
    }
  },
});

function review(frm, action) {
  frappe.confirm(
    action === "approve"
      ? __("Approve this exact source revision and allowed-path boundary? Approval does not run the worker.")
      : __("Reject this development proposal?"),
    () => call(frm, "muster.api.development.review", {proposal: frm.doc.name, action}),
  );
}

async function call(frm, method, args) {
  await frappe.call({method, type: "POST", args, freeze: true});
  await frm.reload_doc();
}
