# Clean Frappe v16 native CRUD and RBAC evidence — 2026-07-20

This receipt records live runtime evidence from the clean Frappe-2 demo site
`frappeverse.local`. It is not a substitute for the final continuous video.

## Governed create executed through the native ERPNext form

- Ask prompt: `Create a new Customer named Live Governed Browser Proof 2026-07-20 as an Individual customer.`
- Ask submit, handoff acceptance, and attended preview all returned successfully.
- The same visible browser tab navigated from Muster Mission Control to ERPNext's native Customer form.
- Muster filled only `customer_name` and `customer_type`, displayed the labeled attended cursor, and paused before Save.
- Proposal `MST-WFP-2026-00004` was reviewed and approved.
- The approved preview displayed `Approve and Save`, followed by a separate native confirmation: `Allow Muster to save this Customer?`
- After confirmation, the native form routed to `/desk/customer/Live%20Governed%20Browser%20Proof%202026-07-20` and displayed both `Saved` and `Saved and verified: Live Governed Browser Proof 2026-07-20`.
- An independent Bench reread returned:

```json
{
  "name": "Live Governed Browser Proof 2026-07-20",
  "customer_name": "Live Governed Browser Proof 2026-07-20",
  "customer_type": "Individual",
  "owner": "Administrator",
  "creation": "2026-07-20 12:42:48.979851"
}
```

The saved form was also rendered and inspected at the explicit mobile viewport
`390x844`; the Customer fields and global Ask Muster control remained visible.

## Exact-record update/delete authority proof without mutation

The deterministic native RBAC fixture created disabled/passwordless evidence
personas and disposable Customer targets, then approved exact-record proposals
through the real review API using a different checker identity.

- Maker: `muster.native.maker@muster.invalid`
- Checker: `muster.native.checker@muster.invalid`
- Denied actor: `muster.native.denied@muster.invalid`
- Update proposal: `MST-WFP-2026-00002`
- Delete proposal: `MST-WFP-2026-00003`
- Update target: `[Muster Native RBAC] Disposable Update Target`
- Delete target: `[Muster Native RBAC] Disposable Delete Target`

The sealed runtime artifact is
[`native-desk-rbac-live-clean-20260720.json`](../../output/evidence/native-desk-rbac-live-clean-20260720.json).
Its file SHA-256 is
`8829e975fdb419602087d9770e03a2baf0af051d017e101b8a5fab10aefa1d87`;
the server-side evidence seal is
`b417074e4fe97cb0acc3cf28672eec911da77548a136c3d9c661fe13d466f64e`.

For both update and delete it proves:

- maker and checker are different identities;
- maker self-approval is denied;
- checker cannot obtain the requester's attended preview;
- stale record revisions are denied;
- the denied actor lacks target authority; and
- `executed` is `false`.

An independent database reread after capture confirmed both disposable target
records retained their original names and revisions. The final video still must
show the browser-visible update and delete pause boundaries with separate live
sessions before this chapter is release-complete.

### Current-schema refresh

After later governed form customization changed the effective Customer schema,
the original proposals failed closed as designed. The fixture now derives its
idempotency key from the exact record plus live schema hash and revision, so it
rotates proposals on schema drift without deleting the immutable older evidence.

- Fresh update proposal: `MST-WFP-2026-00019`
- Fresh delete proposal: `MST-WFP-2026-00020`
- Current server evidence seal: `5110c521c6e721b8ae5585ac4656005362855382a03f6df66b7d6b4ff521f464`
- Artifact: [`native-desk-rbac-live-current-20260720.json`](../../output/evidence/native-desk-rbac-live-current-20260720.json)

The refreshed capture again proves maker/checker separation, requester-only
preview, stale-revision rejection, denied-user blocking, and `executed: false`.
The evidence personas remain disabled and passwordless. Browser execution is
still deliberately unclaimed until the maker/checker video take is recorded.

## Browser-executed native update and delete

The temporary evidence personas were activated with a one-time owner-only
credential, used in the visible browser, and revoked immediately after the run.
The checker and maker remained separate identities throughout.

### Update

- Proposal: `MST-WFP-2026-00019`
- Record identity: `[Muster Native RBAC] Disposable Update Target`
- Reviewed value: `customer_name = [Muster Native RBAC] Update Applied`
- The maker opened the real ERPNext Customer form from the approved proposal.
- Muster displayed its labeled cursor, filled the reviewed field, and paused at
  `Review before Save`.
- The maker selected `Approve and Save` and confirmed Frappe's native Save.
- An independent server reread returned the unchanged document identity, the
  updated customer name, and `modified_by = muster.native.maker@muster.invalid`.
- Stills: [`native-update-paused-20260720.png`](../../output/evidence/native-update-paused-20260720.png)
  and [`native-update-verified-20260720.png`](../../output/evidence/native-update-verified-20260720.png).

### Delete

The first destructive probes failed closed and exposed three real integration
boundaries before any target was lost: Frappe v16's new visible menu contract,
the custom confirmation modal covering the native menu, and Customer User
Permission links that correctly prevent deletion of their referenced Customer.
The final run used ordinary ERPNext role authority plus Muster's exact-record
proposal/capability scope, avoiding a referential link that would make the
requested deletion impossible by construction.

- Proposal: `MST-WFP-2026-00033`
- Target: `[Muster Native RBAC] Disposable Delete Target Role Scoped 6`
- The maker typed the exact target name and acknowledged the destructive boundary.
- Muster visibly used Frappe v16's native `Menu → Delete` confirmation.
- The browser returned to the approved proposal and displayed
  `Deleted and verified`.
- Independent `frappe.db.exists` returned no Customer.
- Authorization receipt: `MST-ADA-2026-00008`
- Receipt state: `Verified`
- Verified actor: `muster.native.maker@muster.invalid`
- Receipt SHA-256:
  `c5809b7657b1608b497c21b626ba9a108b312ce0fdc20d26746ef4832b52fbc7`
- Still: [`native-delete-verified-20260720.png`](../../output/evidence/native-delete-verified-20260720.png).

The live run also proved why the release demo must use the stable no-reloader
Procfile: Bench's development watcher can temporarily remove hashed CSS assets
or restart the web process during a destructive confirmation. The demo runtime
now serves built assets without the watcher while retaining Redis, Socket.IO,
scheduler, and worker processes. The final continuous video remains a separate
release gate.
