---
name: muster-frappe-metadata
description: Design, generate, review, apply, and roll back Frappe or ERPNext metadata changes through Muster. Use for DocTypes, child tables, custom fields, property setters, workflows, roles, permissions, reports, print formats, web pages, workspaces, fixtures, patches, or installed-app compatibility.
---

# Muster Frappe Metadata

Treat every Frappe customization as a typed, reviewable, reversible change set rather than free-form code or direct database mutation.

## Workflow

1. Inspect target Frappe version, installed apps, existing metadata, hooks, fixtures, and customizations.
2. Load `frappe-agent:frappe-customization` and `frappe-agent:frappe-doctype-design`; add backend, SQL, ERPNext, Builder, or Insights skills when the surface requires them.
3. Choose the least invasive layer: runtime configuration, Custom Field/Property Setter, fixture, app-owned standard metadata, patch, then framework override only when necessary.
4. Produce a typed plan with prerequisites, affected records, before snapshot, after value, risk, validation, inverse operation, and approval class.
5. Preview semantic diffs in Frappe. Require explicit approval for schema, permissions, destructive data, executable code, or externally visible artifacts.
6. Apply idempotently in dependency order. Verify metadata caches, migrations, permissions, list/form behavior, reports, prints, and mobile rendering.
7. Persist evidence and a tested rollback or forward-repair path.

Read [frappe-change-set-contract.md](references/frappe-change-set-contract.md) before implementing the planner or executor.

## Surface Invariants

- A Frappe `Workflow` is a document state machine attached to a DocType. A Muster workflow is an agent execution graph. Name and model them separately in plans, schemas, UI, APIs, and tests.
- Frappe Workflow changes preserve reachable states, one valid transition path, role eligibility, docstatus semantics, and existing submitted-document behavior. Exercise every transition as an eligible and ineligible user.
- Query and Script Reports declare columns, filters, reference DocType, permission checks, bounded queries, empty/error behavior, export behavior, and representative result assertions.
- Print Formats and Letter Heads render verified PDF/HTML with escaped untrusted values, correct pagination, translations, attachments/images, and permitted field visibility.
- Client/Server Scripts, custom HTML/Jinja, Web Pages, Webhooks, and code-bearing reports are privileged executable surfaces. Prefer typed generators and reviewed app code; require static checks, explicit approval, sandbox constraints, and injection tests.

## Non-Negotiable Rules

- Use Frappe APIs and migrations; never mutate schema or metadata tables directly.
- Respect app ownership and preserve unrelated customizations.
- Validate link targets, field names, precision, mandatory/default interactions, naming, indexes, translation, and child-table semantics.
- Treat Workflow, Server Script, Client Script, Print Format, Report, and Web Page content as executable or high-risk surfaces.
- Test Administrator, authorized business roles, unrelated roles, Guest, and cross-tenant identities.
- A generated page or report is incomplete until navigation, permissions, data sources, empty/error/loading states, and responsive behavior work.
