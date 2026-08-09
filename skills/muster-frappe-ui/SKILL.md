---
name: muster-frappe-ui
description: Build and validate Muster's native Frappe v16 desktop, Desk, and mobile automation experience. Use for the activity sidecar, mission control, agent/workflow screens, realtime progress, previews, approvals, dynamic pages, accessibility, or responsive interaction design.
---

# Muster Frappe UI

Make automation visible and controllable without monopolizing the user's workspace. Muster must feel native to Frappe v16 while retaining its own execution identity.

## Experience Model

- Use a persistent, collapsible activity dock for background work and a full mission workspace for planning, graphs, artifacts, evidence, and recovery.
- Let users navigate normal DocTypes while runs continue. Deep-link each event to the exact document, diff, approval, log, or artifact.
- Show proposed, approved, executing, waiting, blocked, failed, cancelled, rolled back, and completed states distinctly.
- Render the agent hierarchy and current task, but progressively disclose internal reasoning. Show actions, inputs, outputs, policy decisions, and evidence.
- Provide pause, cancel, retry, edit plan, approve once, approve scope, reject, and open result controls according to permissions.

## Implementation Workflow

1. Inspect Frappe v16 Desk, Workspace Sidebar, desktop icon registration, route conventions, existing design tokens, and mobile breakpoints.
2. Load `frappe-agent:frappe-frontend` and `frappe-agent:frappe-fullstack`.
3. Prefer native Desk pages/components for the shell; use Vue and `frappe-ui` where a richer graph or streaming surface requires it.
4. Subscribe to permission-filtered realtime events and reconcile from durable server state after reconnect.
5. Implement keyboard, focus, screen-reader labels, reduced motion, empty/loading/offline/error states, and narrow viewport behavior.
6. Test with real roles and large timelines on desktop and mobile.

## Brand Contract

Use `https://themuster.dev/assets/brand/muster-mark.png` as the canonical mark, pinned to SHA-256 `2342d61cd09bfa76e411a24a493a3a6a7b22a3be1f55e987ea33c9296e59c50d`. The matching repository copy is currently `website/public/assets/brand/muster-mark.png`. It is the four white inward arms with a violet center. Reject a mismatched hash and do not use the older blue network “M” under `docs/assets`.

Never place secrets, hidden prompts, unrestricted logs, or unauthorized child-run details in browser payloads.

Read [frappe-v16-experience-contract.md](references/frappe-v16-experience-contract.md) for integration and browser gates.
