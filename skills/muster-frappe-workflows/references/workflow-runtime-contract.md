# Workflow runtime contract

Muster's authoritative append-only event stream owns mission state. Frappe stores a permission-filtered projection and its last applied cursor. Projection lag must never authorize an operation.

Every effect is at-least-once and therefore requires a deterministic idempotency key. A claimed node receives a monotonically increasing fencing token; stores reject writes from stale leases. Events have unique ids and a per-mission monotonic sequence. Replay starts after a cursor and tolerates duplicate transport delivery.

Child effective capabilities equal the intersection of caller rights, parent policy, workflow policy, child-agent allowlist, node request, tenant/site scope, current Frappe permissions, remaining budget, and active approval. Any missing or stale term denies execution.

States distinguish cancel-requested, cancelling, cancelled, compensation-running, compensated, needs-intervention, and completed. Completion wins only if committed before the authoritative cancellation event. Non-interruptible calls finish or time out, then their receipts drive compensation or forward repair.

Defaults: depth 3, fan-out 8, active nodes 32, retries 3 with bounded exponential backoff, and explicit ceilings for runtime, model/tool calls, tokens, cost, and artifact bytes. A bounded loop node is allowed; raw cycles are rejected.
