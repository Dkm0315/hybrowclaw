from __future__ import annotations


def customer_service_coverage_v1() -> dict[str, str]:
    """Return the reviewed, immutable implementation for the demo Script Report.

    User prompts can select this definition by registry key, but cannot supply or
    modify executable report code. Frappe executes the stored script in its
    Script Report sandbox.
    """
    return {
        "module": "Muster",
        "report_script": "\n".join([
            "columns = [",
            "    {'fieldname': 'name', 'label': 'Customer', 'fieldtype': 'Link', 'options': 'Customer', 'width': 180},",
            "    {'fieldname': 'customer_name', 'label': 'Customer Name', 'fieldtype': 'Data', 'width': 220},",
            "    {'fieldname': 'customer_group', 'label': 'Account Segment', 'fieldtype': 'Link', 'options': 'Customer Group', 'width': 160},",
            "    {'fieldname': 'territory', 'label': 'Territory', 'fieldtype': 'Link', 'options': 'Territory', 'width': 150},",
            "    {'fieldname': 'muster_service_region', 'label': 'Service Region', 'fieldtype': 'Data', 'width': 130},",
            "]",
            "data = frappe.get_all('Customer', fields=['name', 'customer_name', 'customer_group', 'territory', 'muster_service_region'], order_by='customer_name asc', limit_page_length=500)",
            "result = columns, data",
        ]),
    }


def customer_service_region_client_v1() -> dict[str, object]:
    return {
        "module": "Muster",
        "allowed_doctypes": ["Customer"],
        "allowed_views": ["Form"],
        "script": "\n".join([
            "frappe.ui.form.on('Customer', {",
            "    refresh(frm) {",
            "        frm.toggle_display('muster_service_region', !frm.is_new());",
            "    },",
            "});",
        ]),
    }


def service_request_guard_server_v1() -> dict[str, object]:
    return {
        "module": "Muster", "script_type": "DocType Event",
        "reference_doctype": "Muster Demo Service Request", "doctype_event": "Before Save",
        "allow_guest": 0,
        "script": "if not doc.details:\n    frappe.throw('Details are required')",
    }


def service_health_api_v1() -> dict[str, object]:
    return {
        "module": "Muster", "script_type": "API", "api_method": "muster_service_health",
        "allow_guest": 0, "enable_rate_limit": 1, "rate_limit_count": 30,
        "rate_limit_seconds": 60, "script": "frappe.response['message'] = {'ok': True}",
    }


def service_daily_scheduler_v1() -> dict[str, object]:
    return {
        "module": "Muster", "script_type": "Scheduler Event", "event_frequency": "Daily",
        "allow_guest": 0,
        # Trusted fixtures must resolve to installed runtime code. Reuse the
        # existing idempotent reconciliation job instead of a demo-only path.
        "script": "frappe.enqueue('muster.orchestration.jobs.reconcile_stale_runs')",
    }


def service_request_email_v1() -> dict[str, object]:
    return {
        "module": "Muster", "subject": "Service request {{ doc.name }}",
        "use_html": 1,
        "response_html": "<h2>Service request {{ doc.name }}</h2>{% if doc.status %}<p>Status: {{ doc.status }}</p>{% endif %}",
    }
