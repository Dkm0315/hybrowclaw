# OxygenHR business API profile review

`oxygenhr.business-apis.json` is a deployment-data catalog for
`FRAPPE_BUSINESS_API_CATALOG`. Its top level is intentionally a JSON array,
matching the current runtime parser rather than the customer deployment profile
schema.

## Review basis

- Source: the attached PW HRMS Postman validation archive, generated
  2026-06-23.
- Selection requires an authenticated (`allow_guest=False`) API, an observed
  HTTP 200 safe-read sample, a credible non-error payload, and no mutating
  behavior.
- Parameters are limited to the runtime's current `$employee`, `$user`, and
  `$today` bindings. Optional server defaults are omitted from the profile.
- Every entry projects a minimal allowlist of top-level response fields. The
  catalog does not expose nested descriptions, contact details, comments,
  attachments, email addresses, dates of birth, or fixture-specific values.
- `includeWhen` is used only when the sampled row has a stable predicate that
  matches the intent: active employee records and open job openings. Adding a
  synthetic predicate to other entries would incorrectly suppress valid rows.

## Included P0 reads

| Area | Catalog entries |
| --- | --- |
| Employee and hierarchy | `employee_self_profile`, `employee_direct_reports` |
| Attendance and leave calendar | `leave_balance`, `attendance_current_shift`, `attendance_today_summary`, `leave_holidays_today` |
| Expenses | `expense_shared_with_me` |
| Work communications | `work_announcements` |
| Recruitment | `recruitment_internal_openings`, `recruitment_referral_openings` |
| ToDo delegation | `todo_delegation_summary` |

## Deferred until router support or stronger evidence

| Surface | Representative API | Reason excluded |
| --- | --- | --- |
| Leave applications | `cn_leave_shift_managment.api.get_leave_applications` | The only captured response is an empty list and the generated contract has no item schema. |
| Payroll | `cn_indian_payroll.cn_indian_payroll.overrides.webapp_api.salary_slip_list.get_salary_slip_list` | Captured data is empty; robust routing also needs a trusted company binding and bounded pagination. |
| ToDo list | `cn_todo_manager.chatnext_todo_manager.api.todo_api.get_todo_list` | Requires an intent constant such as `type` and typed pagination/filter inputs; the captured request uses invalid placeholders and returns no item schema. |
| Helpdesk document | `helpdesk.helpdesk.doctype.hd_ticket.api.get_one` | Requires `$input.docname`; its raw response contains extensive contact, comment, assignment, and form metadata. |
| Approval inbox | `cn_leave_shift_managment.api.get_open_approval_todos` | Requires allowlisted doctype/status constants plus typed filters and pagination; captured data is empty. |
| Leave and expense preparation | Field-config, policy, date-range, and check-in APIs | These require `$input` values and belong to safe CRUD preparation rather than P0 reads. |
| Funnel tasks and actions | Assigned-task and permitted-action APIs | Samples are empty or require `$input.doctype` and `$input.docname`; action execution must remain outside a read catalog. |
| Projects, performance, training, accounting, files, reports | No credible P0 custom method in the archive | Continue using permission-aware generic resource/report routing until a non-guest, non-empty, scoped contract is validated. |
| Guest recruitment APIs | Applicant, interview, and offer methods with `allow_guest=True` | Excluded because the payloads are employment PII even when the endpoint is technically public. |

## Required extensions

Future catalog versions need typed sources such as `$input.docname`,
`$input.from_date`, `$input.to_date`, `$input.leave_type`, bounded pagination,
safe enum/constants, and a trusted `$scope.company`. Object-map expansion and
nested-field projection are also required for leave balances and structured
summary payloads. Mutations must continue through `frappe_safe_write`; no
archive mutation method is eligible for this profile.
