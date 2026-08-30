import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase

    from muster.orchestration.read_plan import FrappeReadPlanError, deterministic_count_catalog, deterministic_count_plan, execute_read_plan
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class _Meta:
    istable = False
    issingle = False

    def __init__(self):
        self.fields = {
            "status": SimpleNamespace(fieldtype="Select"),
            "customer": SimpleNamespace(fieldtype="Link"),
            "outstanding_amount": SimpleNamespace(fieldtype="Currency"),
            "password": SimpleNamespace(fieldtype="Password"),
        }

    def get_field(self, fieldname):
        return self.fields.get(fieldname)


class TestFrappeReadPlan(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.user = (frappe.session.user or "Administrator").lower()
        self.base = {
            "schemaVersion": 1,
            "requestId": "read-test-1",
            "disposition": "query",
            "reason": "Fresh invoice evidence is required.",
            "queries": [{
                "doctype": "Sales Invoice", "fields": ["name", "customer"],
                "filters": [{"field": "status", "operator": "=", "value": "Overdue"}],
                "orderBy": [{"field": "name", "direction": "asc"}], "limit": 20,
            }],
        }

    def _security(self, allowed=True):
        return (
            patch("muster.orchestration.read_plan.frappe.db.exists", return_value=True),
            patch("muster.orchestration.read_plan.frappe.get_meta", return_value=_Meta()),
            patch("muster.orchestration.read_plan.frappe.has_permission", return_value=allowed),
            patch("muster.orchestration.read_plan.get_permitted_fields", return_value=["name", "status", "customer", "outstanding_amount"]),
            patch.object(frappe.db, "estimate_count", return_value=100),
        )

    def test_list_count_and_sum_use_permission_enforcing_get_list(self):
        for aggregate, returned in ((None, [{"name": "SINV-1", "customer": "Acme"}]), ({"function": "count"}, [{"value": 7}]), ({"function": "sum", "field": "outstanding_amount"}, [{"value": 1250.5}])):
            plan = {**self.base, "queries": [{**self.base["queries"][0], "fields": [] if aggregate else ["name", "customer"], **({"aggregate": aggregate} if aggregate else {})}]}
            get_list = Mock(return_value=returned)
            security = self._security()
            with security[0], security[1], security[2], security[3], security[4], patch("muster.orchestration.read_plan.frappe.get_list", get_list):
                evidence = execute_read_plan(plan, "read-test-1", self.user)
            self.assertTrue(evidence["permissionFiltered"])
            self.assertEqual(evidence["actor"], self.user)
            get_list.assert_called_once()
            self.assertLessEqual(get_list.call_args.kwargs.get("page_length"), 20)
            if aggregate:
                expected_field = aggregate.get("field") or "name"
                self.assertEqual(
                    get_list.call_args.kwargs["fields"],
                    [{aggregate["function"].upper(): expected_field, "as": "value"}],
                )

    def test_doctype_denial_stops_before_database_read(self):
        get_list = Mock()
        exists, meta, allowed, permitted, estimate = self._security(allowed=False)
        with exists, meta, allowed, permitted, estimate, patch("muster.orchestration.read_plan.frappe.get_list", get_list):
            with self.assertRaises(frappe.PermissionError):
                execute_read_plan(self.base, "read-test-1", self.user)
        get_list.assert_not_called()

    def test_single_doctype_uses_permission_checked_document_not_a_missing_table(self):
        meta = _Meta()
        meta.issingle = True
        meta.fields["time_zone"] = SimpleNamespace(fieldtype="Data")
        document = Mock()
        document.get.side_effect = {"time_zone": "Asia/Kolkata"}.get
        query = {
            "doctype": "System Settings", "fields": ["name", "time_zone"],
            "filters": [], "orderBy": [{"field": "name", "direction": "desc"}], "limit": 1,
        }
        plan = {**self.base, "queries": [query]}
        with (
            patch("muster.orchestration.read_plan.frappe.db.exists", return_value=True),
            patch("muster.orchestration.read_plan.frappe.get_meta", return_value=meta),
            patch("muster.orchestration.read_plan.frappe.has_permission", return_value=True),
            patch("muster.orchestration.read_plan.get_permitted_fields", return_value=["name", "time_zone"]),
            patch("muster.orchestration.read_plan.frappe.get_single", return_value=document) as get_single,
            patch("muster.orchestration.read_plan.frappe.get_list") as get_list,
        ):
            evidence = execute_read_plan(plan, "read-test-1", self.user)
        get_single.assert_called_once_with("System Settings")
        document.check_permission.assert_called_once_with("read")
        get_list.assert_not_called()
        self.assertEqual(evidence["queries"][0]["rows"], [{"name": "System Settings", "time_zone": "Asia/Kolkata"}])

    def test_field_permission_secret_child_join_and_scan_escapes_are_denied(self):
        hostile_queries = [
            {**self.base["queries"][0], "fields": ["password"]},
            {**self.base["queries"][0], "fields": ["customer.customer_name"]},
            {**self.base["queries"][0], "filters": [{"field": "customer", "operator": "like", "value": "%Corp"}]},
            {**self.base["queries"][0], "limit": 101},
        ]
        for query in hostile_queries:
            get_list = Mock()
            exists, meta, allowed, permitted, estimate = self._security()
            with exists, meta, allowed, permitted, estimate, patch("muster.orchestration.read_plan.frappe.get_list", get_list):
                with self.assertRaises((frappe.PermissionError, FrappeReadPlanError)):
                    execute_read_plan({**self.base, "queries": [query]}, "read-test-1", self.user)
            get_list.assert_not_called()

    def test_unknown_sql_method_url_script_and_cross_actor_are_denied(self):
        for key in ("sql", "method", "url", "script"):
            with self.assertRaises(FrappeReadPlanError):
                execute_read_plan({**self.base, key: "hostile"}, "read-test-1", self.user)
        with self.assertRaises(FrappeReadPlanError):
            execute_read_plan(self.base, "read-test-1", "someone-else@example.test")

    def test_unambiguous_count_uses_only_the_permission_filtered_catalog(self):
        catalog = [
            {"doctype": "Customer", "fields": ["name", "customer_name"]},
            {"doctype": "Supplier", "fields": ["name", "supplier_name"]},
            {"doctype": "CRM Lead", "fields": ["name", "first_name"]},
        ]
        plan = deterministic_count_plan("How many Customers are in this site?", catalog, "read-count-1")
        self.assertEqual(plan["requestId"], "read-count-1")
        self.assertEqual(plan["queries"], [{
            "doctype": "Customer", "fields": [], "filters": [],
            "aggregate": {"function": "count"}, "orderBy": [], "limit": 1,
        }])
        self.assertIsNone(deterministic_count_plan("List Customers", catalog, "read-count-2"))
        self.assertIsNone(deterministic_count_plan("How many active Customers are in this site?", catalog, "read-count-filtered"))
        self.assertIsNone(deterministic_count_plan("How many Customers are in this site? Delete the oldest one.", catalog, "read-count-mixed"))
        self.assertIsNone(deterministic_count_plan(
            "How many records are there?",
            [{"doctype": "Customer", "fields": ["name"]}, {"doctype": "Supplier", "fields": ["name"]}],
            "read-count-3",
        ))

    def test_exact_count_catalog_checks_live_actor_and_doctype_permission(self):
        frappe.set_user("Administrator")
        with (
            patch("muster.orchestration.read_plan.frappe.get_user") as current_user,
            patch("muster.orchestration.read_plan.frappe.db.exists", return_value=True),
            patch("muster.orchestration.read_plan.frappe.get_meta", return_value=_Meta()),
            patch("muster.orchestration.read_plan.frappe.has_permission", return_value=True),
        ):
            current_user.return_value.get_can_read.return_value = ["Customer", "Supplier"]
            self.assertEqual(
                deterministic_count_catalog("How many Customers are in this site?", "Administrator"),
                [{"doctype": "Customer", "fields": ["name"]}],
            )
        with self.assertRaises(FrappeReadPlanError):
            deterministic_count_catalog("How many Customers are in this site?", "other@example.test")


if __name__ == "__main__":
    unittest.main()
