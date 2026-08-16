# Frappe Helpdesk Reporting

Muster can package the active, permission-filtered Frappe context and raise an
evidence-rich ticket on a separate Frappe Helpdesk site. The destination is a
deployment setting; `https://support.hybrowlabs.com` is the default rather than
a value embedded in the workflow.

## Security boundary

- The customer site and Helpdesk site are separate authorization domains.
- Each channel sender authorizes the Helpdesk connection once through OAuth.
- Source evidence is bounded and common credential patterns are redacted.
- The ticket is previewed before creation.
- Creation uses Muster's actor-bound, single-use approval receipt.
- Muster reports success only after Helpdesk returns and rereads the ticket.

## Operator setup

Create a private mode-0600 OAuth credential JSON for the Helpdesk OAuth Client,
then register it without putting a client secret on the command line:

```bash
muster frappe setup \
  --site-url https://support.hybrowlabs.com \
  --oauth-credential-file ~/.muster/credentials/hybrow-support.json \
  --connection-id hybrow-support \
  --support-customer "Vinman App" \
  --support
```

The OAuth Client must contain the exact redirect URI printed by the command.
The customer site's normal Frappe connection remains the default connection.
The optional customer is a deployment mapping and must already exist on the
Helpdesk site. Muster never guesses a customer from a sender or source URL.

Each user connects the support identity once from the same channel:

```text
/pair start hybrow-support
```

## User flow

From the affected Frappe record or workspace, the user can say:

```text
Report this engineering revision mismatch to support
```

or run:

```text
/report-issue downstream records still use the previous approved revision
```

Muster builds a draft containing the reporter, source site, current record,
permission-filtered evidence, a verified record link, and a recommended
reproduction boundary. The user reviews the live Helpdesk fields and selects
`Accept & create`. The final response contains the verified Helpdesk ticket
reference and link.

## Engineering Change Escape demo

Use controlled demo records, never customer production records. Prepare one
component whose new drawing revision is approved while one or more downstream
documents retain the previous operation, tolerance, inspection, sampling, or
tooling value. The strongest demo uses a mismatch that is individually valid
inside every record but inconsistent across the lineage.

The user asks why production still follows the previous specification. Muster
should show the affected record links and explain where propagation stopped.
The user then asks Muster to report the issue. The ticket must include expected
versus observed revision state, affected links, operational impact, and a
bounded validation recommendation. Ticket creation remains human-approved.

## Four controlled demo scenarios

1. **Customization escape:** create a staging-only revision mismatch between a
   source engineering record and one downstream record. Muster compares the
   live schema, scripts, workflow state, and linked records; it explains where
   propagation stopped and offers a Helpdesk draft.
2. **Code or runtime failure:** trigger a reversible, known error in a demo
   customization. The ticket contains a sanitized error fingerprint, app and
   schema versions, reproduction steps, affected links, likely customization
   boundary, and a deterministic validation recommendation. Raw credentials
   and unbounded logs are never copied.
3. **Complex business validation:** trigger a rule whose message comes from a
   Custom Field, Property Setter, Workflow, Client Script, Server Script, hook,
   or override. Muster first explains the message in business language, then
   distinguishes an expected rule from a defect. Technical locations are shown
   only when useful to the user's role.
4. **Version migration:** on a restored staging backup, capture a pre-upgrade
   baseline, run compatibility and migration checks, classify each failure,
   and either guide an approved correction or create a ticket. The evidence
   includes source and target versions, app revisions, failed patch or schema
   boundary, reproduction, restoration state, and post-fix validation.

Each scenario must use controlled demo data, preserve a restoration point, and
finish with verified linked records or a verified Helpdesk ticket. A successful
command exit alone is not evidence of success.
