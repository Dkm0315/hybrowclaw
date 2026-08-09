# Frappe v16 experience contract

Register Muster in Frappe v16's `/desk` experience through Desktop Icon and Workspace Sidebar metadata. The persistent shell is app JS/CSS; the full mission control route is `/desk/muster-control`. If the rich Vue surface fails, standard Mission, Approval, Change Set, Activity, and Artifact forms remain usable.

Desktop uses a collapsible/resizable right dock. At 430px and below it becomes a safe-area-aware bottom sheet plus activity badge. Minimum touch target is 44px. Test 1440, 1024, 430, 390, and 320 widths plus current Chrome, Safari, Firefox, and mobile WebKit.

Server-side permissions filter every boot payload, realtime event, cursor page, reference, and download. The client virtualizes large timelines, caps payloads, synchronizes tabs, resumes after the last durable sequence, deduplicates events, preserves browser-back behavior, and shows degraded/offline/reconnect states.

Do not expose chain-of-thought. Show observable actions, tool/change summaries, permission decisions, provider-supported summaries, artifacts, receipts, and evidence. Support keyboard control, focus restoration, screen-reader labels, reduced motion, pause/steer/cancel, and large-text zoom.
