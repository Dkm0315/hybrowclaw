# Frappe change-set contract

Each set records an immutable plan hash, target site/app, actor, permission epoch, schema/data revision, risk class, approval class, prerequisites, operations, verification, and rollback status.

Each operation records:

- operation id, surface, action, target, dependencies, and idempotency key;
- canonical before/after snapshots and optimistic concurrency value;
- required Frappe permission and policy capability;
- dry-run and semantic diff;
- effect receipt and postcondition assertions;
- inverse operation when safe, otherwise a forward-repair plan.

Risk classes are read-only, record mutation, workflow/business-state mutation, metadata/UI, executable integration, security/permission, and destructive. The last four require explicit scoped approval by default. Approval binds the plan hash, actor, approver, site, permission epoch, scope, and expiry.

One active native Frappe Workflow may govern a DocType. Validate state-field compatibility, reachable states, transition roles/conditions, self-approval policy, docstatus submit/cancel behavior, and migration of existing records. For reports, test permission-filtered rows, filters, exports, prepared execution, and bounded queries. For print, verify escaped values, permitted fields, letterhead, translation, pagination, and rendered PDF.
