frappe.ui.form.on("Muster Change Set", {
  refresh(frm) {
    if (frm.is_new() || frm.doc.actor !== frappe.session.user) return;
    if (["Preflighted", "Awaiting Approval", "Approved"].includes(frm.doc.status)) {
      frm.add_custom_button(__("Open native form review"), () => {
        if (!window.musterNativeCustomization?.start) {
          frappe.msgprint(__("The attended customization surface is unavailable. Reload Desk and try again."));
          return;
        }
        window.musterNativeCustomization.start(frm.doc.name).catch(() => {
          frappe.msgprint({
            title: __("Attended customization stopped"),
            message: __("Nothing was applied. Review the Change Set evidence before trying again."),
            indicator: "red",
          });
        });
      });
    }
    if (frm.doc.status === "Verified") {
      frm.add_custom_button(__("Review native rollback"), () => {
        if (!window.musterNativeCustomization?.startRollback) {
          frappe.msgprint(__("The attended customization surface is unavailable. Reload Desk and try again."));
          return;
        }
        window.musterNativeCustomization.startRollback(frm.doc.name).catch(() => {
          frappe.msgprint({
            title: __("Rollback review stopped"),
            message: __("Nothing was rolled back. A separate Destructive approval is required."),
            indicator: "red",
          });
        });
      });
    }
  },
});
