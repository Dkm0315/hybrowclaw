# Frappe RBAC Video Evidence Runbook

Every release claim below requires a real browser recording. A JSON evidence record
and automated test receipt support the video but never replace it. Record at normal
speed with the signed-in user, route, action, result, and corresponding audit record
visible. Do not edit the video to remove failures; restart a scenario with a new ID.

## Recording rules

- Begin every persona series with an Administrator setup chapter recorded in Desk:
  create/open User, assign roles, add Company/Territory/Department/Warehouse/Employee
  User Permissions, configure Muster Role Binding and Policy, save, and show the
  resulting permission epoch. Dataset bootstrap commands are not configuration proof.
- Show the equivalent manual setup even when a deterministic seeder created the
  starting records. Password entry must remain masked and credentials must never be
  spoken, captioned, logged, or stored in the evidence manifest.
- Record the login identity and assigned business role before the action.
- Show an allowed action and its paired hidden/denied action in the same chapter.
- Demonstrate list filtering and a direct URL/API access attempt; an empty list alone
  is not sufficient denial evidence.
- For writes, show the saved document and Version/Audit/Muster Activity receipt.
- For denials, show that no document, approval, ledger, or background job was created.
- Record desktop (1440×900) and mobile (390×844); critical prompt and approval cases
  also require 320×720.
- Store the original WebM privately in Frappe, calculate SHA-256, and link its exact
  site revision, persona, test receipt, and chapter timestamps.

## Required real-life chapters

| ID | App | Persona | Allowed proof | Paired denied/hidden proof |
|---|---|---|---|---|
| MUS-01 | Muster | Sales Operator | Create and read own sales mission | Cannot read another operator's private mission by URL |
| MUS-02 | Muster | Automation Manager | Publish a bounded workflow version | Cannot execute privileged artifact change without approval |
| MUS-03 | Muster | Independent Approver | Approve another user's exact plan hash | Cannot approve own request or changed plan hash |
| MUS-04 | Muster | Auditor | Read mission, activity, receipt, and video evidence | Cannot pause, steer, edit, or apply |
| MUS-05 | Muster | Viewer | Read participant-visible completed mission | Cannot create mission or see restricted evidence |
| MUS-06 | Muster | HR Operator | Run HR-scoped workflow | Cannot grant finance/customer capabilities |
| MUS-07 | Muster | Sales Operator | Pause and resume own live mission | Cannot control another user's root run |
| MUS-08 | Muster | System Manager | Revoke role binding and observe epoch invalidation | Old Telegram/control token cannot be replayed |
| ERP-01 | ERPNext | Sales User A | Read/update own territory/customer lead | Customer in another company/territory is hidden and direct URL denied |
| ERP-02 | ERPNext | Sales Manager | Approve valid quotation/order workflow | Cannot submit after approval was revoked or document changed |
| ERP-03 | ERPNext | Purchase User | Create Material Request/Purchase Order draft | Cannot read or amend submitted Sales Invoice |
| ERP-04 | ERPNext | Purchase Manager | Approve supplier purchase inside company | Cannot approve own over-limit request without second approver |
| ERP-05 | ERPNext | Accounts User | Prepare draft Journal Entry | Cannot submit or cancel without Accounts Manager authority |
| ERP-06 | ERPNext | Accounts Manager | Submit verified Journal Entry | Cannot access another company's ledger through report filters or URL |
| ERP-07 | ERPNext | Stock User | Create Stock Entry within assigned warehouse | Other warehouse stock and valuation are hidden/denied |
| ERP-08 | ERPNext | Executive Viewer | View allowed management report totals | Cannot drill into masked employee/customer details |
| HRM-01 | HRMS | Employee | Read own Employee/Leave/Expense records | Another employee's salary and leave document are denied by URL |
| HRM-02 | HRMS | Leave Approver | Approve subordinate leave | Own leave request cannot be self-approved |
| HRM-03 | HRMS | HR User | Maintain employee onboarding fields | Salary structure and payroll submission remain denied |
| HRM-04 | HRMS | Payroll Manager | Process assigned-company payroll | Other company payroll and private attachments are denied |
| CRM-01 | CRM | SDR A | Read/update assigned lead and create ToDo | SDR B's private lead/deal is hidden and direct URL denied |
| CRM-02 | CRM | Sales Manager | Reassign team deal and view team pipeline | Cannot view another company's pipeline |
| CRM-03 | CRM | Support/Telephony User | Link permitted call to contact | Cannot export the contact list or expose private phone data |
| CRM-04 | CRM | Auditor | Read pipeline change/version evidence | Cannot modify lead status, owner, or deal value |

## Required human-configuration chapters

| ID | Configuration shown end to end |
|---|---|
| CFG-01 | Create a Frappe user, assign System User type and Muster role, save, inspect effective roles |
| CFG-02 | Add and remove Company User Permission; demonstrate immediate list/direct-URL effect |
| CFG-03 | Configure Territory and Customer restrictions for Sales User A and B |
| CFG-04 | Configure Warehouse restriction and Stock User permissions |
| CFG-05 | Link User to Employee, Department, Leave Approver, and HR permissions |
| CFG-06 | Configure CRM lead/deal assignment and manager hierarchy |
| CFG-07 | Create Muster Site Binding and show pending/trusted state requirements without exposing secrets |
| CFG-08 | Create User/Role Muster Role Bindings with exact site/module/workflow scope |
| CFG-09 | Create allow and deny Muster Policy rules, approval class, priority, and validity window |
| CFG-10 | Build and publish a multi-agent workflow version, showing capability and budget bounds |
| CFG-11 | Create independent approver assignment and prove separation of duties |
| CFG-12 | Revoke permission/role binding and show permission-epoch/token invalidation |

## Release gate

The release fails if any required chapter is missing, lacks a paired allow/deny proof,
has no SHA-256/private File evidence, shows a different actor than the manifest, or
cannot be replayed against the referenced deterministic scenario dataset.
