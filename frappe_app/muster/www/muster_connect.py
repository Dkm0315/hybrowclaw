from __future__ import annotations

from urllib.parse import quote

import frappe

from muster.adapters.client import GatewayClientError, normalized_https_origin
from muster.api.onboarding import (
    MusterOnboardingError,
    _administrator_required,
    _consume_pending,
    _site_origin,
    complete,
)

no_cache = 1


def get_context(context):
    context.no_cache = 1
    context.success = False
    context.error = None
    state = frappe.form_dict.get("state") or ""
    code = frappe.form_dict.get("code") or ""
    oauth_error = frappe.form_dict.get("error")
    gateway_url = frappe.form_dict.get("gateway_url") or ""

    # The CLI opens this route first so Frappe remains the visible consent and
    # authority surface. It is distinct from the OAuth callback below.
    if gateway_url and not state and not code and not oauth_error:
        context.mode = "consent"
        current_path = f"/muster-connect?gateway_url={quote(gateway_url, safe='')}"
        if frappe.session.user == "Guest":
            context.requires_login = True
            context.login_url = f"/login?redirect-to={quote(current_path, safe='')}"
            return context
        try:
            _administrator_required()
            context.gateway_url = normalized_https_origin(gateway_url)
            context.site_url = _site_origin()
            context.consent_ready = True
        except (GatewayClientError, MusterOnboardingError, frappe.PermissionError) as error:
            context.error = str(error)
        return context

    context.mode = "callback"
    if oauth_error:
        try:
            _consume_pending(state)
        except MusterOnboardingError:
            pass
        context.error = "Muster authorization was cancelled or denied. No connection was created."
        return context
    try:
        complete(code, state)
        # Frappe's normal request transaction does not commit mutations made
        # while rendering a GET website route. The OAuth redirect must remain
        # a browser GET, so commit only after both challenges have been
        # verified and the complete trust record has been persisted.
        frappe.db.commit()
        context.success = True
    except MusterOnboardingError:
        frappe.db.rollback()
        context.error = (
            "Muster could not verify the connection. No trust was created; "
            "return to settings and try again."
        )
    except Exception:
        frappe.db.rollback()
        # Do not capture request arguments or stack locals: OAuth codes, verifiers,
        # and issued credentials must never enter Error Log.
        frappe.log_error(
            message="An unexpected error interrupted the Muster onboarding callback.",
            title="Muster onboarding callback failed",
        )
        context.error = (
            "Muster could not verify the connection. No trust was created; "
            "return to settings and try again."
        )
    return context
