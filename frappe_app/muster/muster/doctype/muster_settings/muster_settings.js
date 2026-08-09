frappe.ui.form.on("Muster Settings", {
  refresh(frm) {
    const connected = frm.doc.enabled && frm.doc.binding_status === "Trusted";
    const status = connected ? __("Connected") : __(frm.doc.binding_status || "Not connected");
    const tone = connected ? "green" : "orange";
    frm.set_intro(__("Muster connection: {0}", [`<strong class=\"text-${tone}\">${frappe.utils.escape_html(status)}</strong>`]));
    frm.fields_dict.connection_help.$wrapper.html(`
      <div class="muster-connect-card">
        <strong>${connected ? __("Muster is ready") : __("Connect this site to Muster")}</strong>
        <p class="text-muted">${connected
          ? __("The gateway and this Frappe site completed reciprocal trust verification.")
          : __("Authorize once with OAuth and Muster will create the site binding automatically. No token is shown in the browser.")}</p>
      </div>
    `);
    frm.add_custom_button(connected ? __("Reconnect Muster") : __("Connect to Muster"), () => openConnectDialog(frm), __("Muster"));
  },
});

function openConnectDialog(frm) {
  const dialog = new frappe.ui.Dialog({
    title: __("Connect to Muster"),
    fields: [
      { fieldname: "gateway_url", fieldtype: "Data", label: __("Muster Gateway URL"), reqd: 1, default: frm.doc.gateway_url || "https://" },
      { fieldname: "site_url", fieldtype: "Data", label: __("Public Frappe Site URL"), reqd: 1, default: window.location.origin, description: __("Both URLs must use HTTPS and must be exact origins.") },
    ],
    primary_action_label: __("Authorize with Muster"),
    async primary_action(values) {
      dialog.disable_primary_action();
      try {
        const result = await frappe.call({ method: "muster.api.onboarding.begin", args: values, freeze: true, freeze_message: __("Preparing secure connection…") });
        window.location.assign(result.message.authorization_url);
      } finally {
        dialog.enable_primary_action();
      }
    },
    secondary_action_label: __("Use API credentials"),
    secondary_action() {
      dialog.hide();
      openCredentialDialog(frm);
    },
  });
  dialog.show();
}

function randomNonce() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function openCredentialDialog(frm) {
  const dialog = new frappe.ui.Dialog({
    title: __("Connect with API credentials"),
    fields: [
      { fieldname: "notice", fieldtype: "HTML", options: `<p class="text-muted">${__("Use this only when OAuth is unavailable. Credentials are exchanged once over HTTPS and are not saved in Frappe.")}</p>` },
      { fieldname: "gateway_url", fieldtype: "Data", label: __("Muster Gateway URL"), reqd: 1, default: frm.doc.gateway_url || "https://" },
      { fieldname: "site_url", fieldtype: "Data", label: __("Public Frappe Site URL"), reqd: 1, default: window.location.origin },
      { fieldname: "api_key", fieldtype: "Data", label: __("API Key"), reqd: 1 },
      { fieldname: "api_secret", fieldtype: "Password", label: __("API Secret"), reqd: 1 },
    ],
    primary_action_label: __("Verify and connect"),
    async primary_action(values) {
      dialog.disable_primary_action();
      try {
        await frappe.call({
          method: "muster.api.onboarding.connect_with_api_credentials",
          args: { ...values, nonce: randomNonce() },
          freeze: true,
          freeze_message: __("Verifying reciprocal trust…"),
        });
        dialog.hide();
        frappe.show_alert({ message: __("Muster connected"), indicator: "green" });
        await frm.reload_doc();
      } finally {
        dialog.enable_primary_action();
      }
    },
  });
  dialog.show();
}
