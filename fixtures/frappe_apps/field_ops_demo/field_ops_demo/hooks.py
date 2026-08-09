app_name = "field_ops_demo"
app_title = "Field Ops Demo"
app_publisher = "Field Ops Demo"
app_description = "Independent Frappe v16 Vue field-operations reference application"
app_email = "field-ops@example.invalid"
app_license = "MIT"

website_route_rules = [
    {"from_route": "/operations/<path:app_path>", "to_route": "operations"},
]
