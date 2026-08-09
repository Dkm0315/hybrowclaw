---
name: muster-frappe-security
description: Threat-model and negatively verify Muster integrations with Frappe OAuth, multi-tenancy, RBAC, field permissions, agent delegation, channels, secrets, approvals, and audit logs. Use for identity linking, site registration, Telegram onboarding, policy changes, permission tests, or security release gates.
---

# Muster Frappe Security

Make identity and authorization continuous: authenticate the actor, bind the tenant/site, resolve the effective Frappe user, authorize the exact operation, constrain delegated agents, and audit the outcome.

## Trust Model

- A tenant, Frappe site, Muster gateway, channel identity, and Frappe user are separate principals with explicit bindings.
- OAuth proves an identity and scopes a token; it does not replace Frappe role and document permission checks.
- Child agents receive attenuated capabilities, never an ambient copy of the parent session.
- Background and Telegram actions run as a recorded user or service principal with bounded roles, expiry, and revocation.
- Credentials are encrypted at rest, redacted everywhere, rotated, and never placed in workflow JSON, browser state, events, or artifacts.

## Review Workflow

1. Draw trust boundaries and data flows for browser, Frappe, Muster gateway, workers, model providers, channels, and storage.
2. Enumerate assets, actors, entry points, escalation paths, and cross-tenant identifiers.
3. Define deny-by-default policy and the exact Frappe permission API used at plan, approval, execution, and readback time.
4. Bind approvals to immutable action hashes, identity, tenant, scope, and expiry. Revalidate after any change.
5. Keep high-risk operations behind fresh approval and server-side enforcement.
6. Produce automated positive and negative matrices plus auditable evidence.

## Required Attacks

Test horizontal and vertical privilege escalation, tenant/site confusion, forged OAuth state, token replay, revoked roles, field-level leakage, child-agent overreach, approval substitution, prompt/tool injection, webhook forgery, Telegram identity collision, ID enumeration, SSRF, stored XSS, unsafe print/template code, queue replay, log leakage, and denial-of-service limits.

Do not use generic pairing as proof of a Frappe identity. A streamlined channel onboarding flow may start from an authenticated Frappe session and a short-lived one-time link, but it must retain explicit consent, expiry, single use, device/channel confirmation, and revocation.

For Telegram, Frappe issues an opaque one-time state whose server record binds site id, Frappe user, bot/account id, intended provider, nonce hash, issued/expiry time, requested scopes, and current permission epoch. The bot redeems it only after `/start`, then binds the observed Telegram user and chat; wrong bot, wrong site, expiry, replay, or changed permission epoch fails closed. Show the exact resulting identity in Frappe and allow immediate revocation.

OAuth state binds the same site, user, provider, redirect origin, PKCE verifier reference, nonce, expiry, and requested scopes. Site URL or tenant rebind requires a fresh administrator-authorized bootstrap and invalidates prior tokens, channel links, approvals, cached permissions, and active delegated leases; never silently migrate a binding based on a hostname supplied by the browser.

Use the full positive and negative state machine in [identity-linking-contract.md](references/identity-linking-contract.md).
