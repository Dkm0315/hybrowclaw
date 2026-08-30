/**
 * Browser contract for the Vinman recorder.
 *
 * The data-* selectors are the stable contract expected from the future Muster
 * surface. Legacy class fallbacks are kept only for the existing demo shell.
 * Scenario evidence and receipts must carry the scenario id so a generic
 * success message cannot satisfy the wrong recording.
 */
export const VINMAN_SELECTORS = Object.freeze({
  login: Object.freeze({
    user: "#login_email, input[name='usr']",
    password: "#login_password, input[name='pwd']",
    submit: "[data-frappe-login-submit], button.btn-login, button:has-text('Login')",
  }),
  muster: Object.freeze({
    toggle: "[data-muster-toggle], .muster-dock-toggle",
    prompt: "[data-muster-prompt], .muster-dock-prompt",
    submit: "[data-muster-submit], .muster-dock-submit",
    messages: "[data-muster-message], .muster-chat-message",
    assistantMessages: "[data-muster-message][data-muster-role='assistant'], .muster-chat-message.is-assistant",
    evidence: (scenarioId) => `[data-muster-evidence][data-muster-scenario='${scenarioId}']`,
    takeover: "[data-muster-takeover], .muster-attended-overlay",
    waitingTakeover: "[data-muster-takeover][data-muster-takeover-state='waiting'], .muster-attended-overlay[data-waiting='true'], [data-muster-lineage-review]",
    review: "[data-muster-review], [data-attended-review]",
    launch: (scenarioId) => `[data-muster-handoff-kind='${scenarioId === "revision-escape" ? "lineage_remediation" : scenarioId === "authorized-customization-repair" ? "customization_repair" : scenarioId}']`,
    approve: "[data-muster-approve], [data-attended-approve], [data-attended-save], [data-lineage-approve], [data-presentation-command='/accept'], .modal.show .btn-primary",
    followUp: "[data-muster-follow-up][data-visible='true'], [data-muster-awaiting-user-input='true']",
    receipt: (scenarioId) => `[data-muster-receipt][data-muster-scenario='${scenarioId}']`,
  }),
});

export const VINMAN_RECEIPT_ATTRIBUTES = Object.freeze({
  id: "data-muster-receipt-id",
  status: "data-muster-receipt-status",
  scenario: "data-muster-scenario",
});
