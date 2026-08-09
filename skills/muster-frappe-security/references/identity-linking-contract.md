# Identity-linking contract

Preferred Telegram flow: authenticated Frappe user requests link, Frappe stores a hashed short-lived single-use state, UI opens the configured bot with the opaque token, bot observes numeric user/chat/bot identifiers, server redeems atomically, user confirms the resulting identity in Frappe, and an auditable revocable binding becomes active.

Never bind on username, display name, email, phone, or Employee alone. Verify webhook secret, deduplicate Telegram `update_id`, constrain chat type, use uniform errors, and keep artifacts behind authenticated permission-checked download URLs.

Negative states include wrong site, issuer, user, bot, chat type, state, nonce, permission epoch, redirect URI, or PKCE verifier; expired/replayed/revoked token; parallel redemption; account already bound elsewhere; role revoked during linking; multi-site ambiguity; unlink/relink race; and old webhook replay.

Changing site origin, gateway tenant, signing keys, or provider account is a rebind. Rebind requires fresh administrator authority and invalidates active identity links, OAuth grants, approvals, caches, leases, and trusted ingress credentials associated with the old binding.
