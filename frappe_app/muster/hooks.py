app_name = "muster"
app_title = "Muster"
app_publisher = "Muster"
app_description = "Governed AI automation operating system for Frappe"
app_email = "engineering@themuster.dev"
app_license = "AGPL-3.0-or-later"
required_apps = ["frappe"]

add_to_apps_screen = [
    {
        "name": "muster",
        "logo": "/assets/muster/images/muster-mark.png",
        "title": "Muster",
        "route": "/desk/muster-control",
        "has_permission": "muster.permissions.has_app_permission",
    }
]

app_include_css = [
    "/assets/muster/css/muster.css?v=20260808-5",
    "/assets/muster/css/studio.css",
]
app_include_js = [
    "/assets/muster/js/workflow_graph.js",
    "/assets/muster/js/surface_adapters.js?v=20260808-27",
    "/assets/muster/js/native_customization_session.js?v=20260720-5",
    "/assets/muster/js/live_work_session.js?v=20260808-9",
    "/assets/muster/js/activity_dock.js?v=20260808-10",
]

# Muster's site-level registry detects standalone Vue/React surfaces and loads
# Muster-owned adapters. CRM, Helpdesk, HRMS and customer apps remain untouched.
web_include_js = [
    "/assets/muster/js/surface_adapters.js?v=20260808-27",
    "/assets/muster/js/spa_assistant.js?v=20260808-5",
]

# Keep the public OAuth callback human-readable while loading a valid Python
# module name for its authenticated consent and reciprocal-verification logic.
website_route_rules = [
    {"from_route": "/muster-connect", "to_route": "muster_connect"},
]

after_install = "muster.install.after_install"
after_migrate = "muster.install.after_migrate"
boot_session = "muster.boot.boot_session"

# Executable artifact bodies are installed code selected by a fixed registry
# key. Prompts may reference the key, never provide raw scripts.
muster_trusted_artifact_builders = {
    "script_report.customer-service-coverage-v1":
        "muster.automation.trusted_artifacts.customer_service_coverage_v1",
    "client_script.customer-service-region-v1":
        "muster.automation.trusted_artifacts.customer_service_region_client_v1",
    "server_script.service-request-guard-v1":
        "muster.automation.trusted_artifacts.service_request_guard_server_v1",
    "server_script.service-health-api-v1":
        "muster.automation.trusted_artifacts.service_health_api_v1",
    "server_script.service-daily-scheduler-v1":
        "muster.automation.trusted_artifacts.service_daily_scheduler_v1",
    "email_template.service-request-v1":
        "muster.automation.trusted_artifacts.service_request_email_v1",
}

# Standalone Frappe Vue/React apps do not necessarily consume web_include_js.
# This hook changes only authenticated, buffered HTML for an explicit SPA allowlist.
after_request = ["muster.spa_shell.inject_muster_spa_shell"]

permission_query_conditions = {
    "Muster Mission": "muster.permissions.mission_query",
    "Muster Workflow Proposal": "muster.permissions.workflow_proposal_query",
    "Muster Ask Turn": "muster.permissions.ask_turn_query",
    "Muster Development Proposal": "muster.permissions.development_proposal_query",
    "Muster Work Unit": "muster.permissions.work_unit_query",
    "Muster Run": "muster.permissions.run_query",
    "Muster Activity": "muster.permissions.activity_query",
    "Muster Approval": "muster.permissions.approval_query",
    "Muster Artifact": "muster.permissions.artifact_query",
    "Muster Evidence Clip": "muster.permissions.evidence_clip_query",
    "Muster Channel Identity": "muster.permissions.channel_identity_query",
}

has_permission = {
    "Muster Mission": "muster.permissions.mission_has_permission",
    "Muster Workflow Proposal": "muster.permissions.workflow_proposal_has_permission",
    "Muster Ask Turn": "muster.permissions.ask_turn_has_permission",
    "Muster Development Proposal": "muster.permissions.development_proposal_has_permission",
    "Muster Approval": "muster.permissions.approval_has_permission",
    "Muster Artifact": "muster.permissions.artifact_has_permission",
    "Muster Evidence Clip": "muster.permissions.evidence_clip_has_permission",
    "Muster Channel Identity": "muster.permissions.channel_identity_has_permission",
}

scheduler_events = {
    "cron": {
        "*/5 * * * *": ["muster.orchestration.jobs.reconcile_stale_runs"],
        "15 * * * *": ["muster.orchestration.jobs.prune_expired_links"],
    }
}

doc_events = {
    "Muster Mission": {
        "on_update": "muster.orchestration.events.publish_mission_projection",
    },
}
