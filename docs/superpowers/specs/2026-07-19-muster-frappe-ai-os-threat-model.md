# Muster Frappe AI OS Threat Model

## Trust boundaries

Browser, Frappe site, Muster gateway, graph workers, model/tool providers, database/Redis/object storage, Telegram/webhooks, and target external systems are separate trust zones. Tenant, site, user, role, agent, channel identity, and service identity are separate principals.

## Protected assets

Frappe records and metadata; roles, User Permissions, shares and field values; OAuth/channel/model credentials; workflow instructions and policies; approvals and action hashes; artifacts; audit evidence; budgets; signing/encryption keys; customer and employee data.

## Mandatory controls

- deny by default and authorize at plan, approval, execution and readback;
- intersect Frappe authorization with Muster policy, delegation and budget;
- sign or mutually authenticate server ingress; never trust browser-supplied roles/site/user;
- bind approvals to immutable action hash, site, actor, permission epoch, scope and expiry;
- encrypt and rotate credentials, redact all outputs, and use private authorized artifact delivery;
- fence leases, deduplicate effects/events/webhooks, cap all resources, and audit every decision;
- render untrusted content safely and prohibit arbitrary model-authored executable code by default;
- invalidate trust, tokens, links, approvals, caches and leases on site rebind or relevant revocation.

## Required negative cases

Cross-site/user/company lookup and mutation; field-permission leakage; guessed identifiers/export/share/report; role revocation mid-run; delegated scope widening; forged/replayed OAuth state, approval, ingress, Telegram link and update; wrong bot/chat/site/redirect; prompt and tool injection from records/files; stored/reflected XSS; unsafe Jinja/report/script; SSRF; malicious filename/path traversal; oversized artifact/payload; raw log/secret leakage; duplicate commands; stale fencing; worker death; Redis/gateway/network loss; event cursor replay/backpressure; schema/data drift; concurrent edits; partial apply and failed compensation; queue starvation and budget exhaustion.

Every denial asserts both the error and absence of side effects or leaked evidence.
