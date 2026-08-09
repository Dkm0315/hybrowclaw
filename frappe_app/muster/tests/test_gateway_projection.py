import unittest
from datetime import timedelta
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    from frappe.utils import now_datetime

    from muster.adapters.client import GatewayBinding
    from muster.orchestration.projection import ProjectionError, project_gateway_snapshot
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe integration tests require an installed test site") from exc


class TestGatewayProjection(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        suffix = uuid4().hex[:10]
        self.operator = self._make_user(f"projection-{suffix}@example.test")
        frappe.set_user("Administrator")
        self.mission = self._make_mission(suffix)
        self.binding = GatewayBinding(
            origin="https://gateway.example.test",
            bearer="secret",
            tenant_id=f"tenant-{suffix}",
            site_id=f"site-{suffix}",
            site_origin="https://erp.example.test",
            hmac_secret="hmac-secret",
        )

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def _make_user(self, email):
        return frappe.get_doc(
            {
                "doctype": "User",
                "email": email,
                "first_name": "Projection Test",
                "enabled": 1,
                "send_welcome_email": 0,
                "roles": [{"role": "Muster Operator"}],
            }
        ).insert(ignore_permissions=True).name

    def _make_mission(self, suffix):
        return frappe.get_doc(
            {
                "doctype": "Muster Mission",
                "objective": "Project a validated authoritative graph run into native Frappe records",
                "status": "Queued",
                "requested_by": self.operator,
                "requested_at": now_datetime(),
                "idempotency_key": f"projection-{suffix}",
            }
        ).insert()

    def _snapshot(self):
        started = now_datetime()
        root = f"run-{uuid4().hex}"
        node = "verify"
        attempt = "attempt-1"

        def event(sequence, event_type, **extra):
            return {
                "schemaVersion": 1,
                "id": f"event-{root}-{sequence}",
                "missionId": self.mission.name,
                "rootRunId": root,
                "tenantId": self.binding.tenant_id,
                "siteId": self.binding.site_id,
                "sequence": sequence,
                "type": event_type,
                "at": str(started + timedelta(seconds=sequence)),
                "actorId": self.operator,
                "summary": f"Safe projected event {sequence}",
                **extra,
            }

        events = [
            event(1, "mission_started", payload={"workflowId": "test"}),
            event(
                2,
                "node_started",
                nodeId=node,
                attemptId=attempt,
                payload={"nodeKind": "verification", "parentNodeIds": [], "depth": 0},
            ),
            event(
                3,
                "lease_claimed",
                nodeId=node,
                attemptId=attempt,
                fencingToken=1,
                payload={"leaseExpiresAt": str(started + timedelta(minutes=5))},
            ),
            event(4, "node_completed", nodeId=node, attemptId=attempt, fencingToken=1),
            event(5, "mission_completed"),
        ]
        return {
            "missionId": self.mission.name,
            "rootRunId": root,
            "status": "completed",
            "nextSequence": 6,
            "nodes": [
                {
                    "nodeId": node,
                    "status": "completed",
                    "attemptId": attempt,
                    "fencingToken": 1,
                }
            ],
            "events": events,
        }

    def test_snapshot_projects_idempotently_to_native_records(self):
        snapshot = self._snapshot()
        first = project_gateway_snapshot(
            self.mission.name,
            snapshot,
            self.binding,
            poll_path=f"/v1/integrations/frappe/missions/{self.mission.name}",
        )
        second = project_gateway_snapshot(self.mission.name, snapshot, self.binding)

        self.assertEqual(first["status"], "Completed")
        self.assertEqual(second["events"], 5)
        self.assertEqual(frappe.db.count("Muster Activity", {"mission": self.mission.name}), 5)
        self.assertEqual(frappe.db.count("Muster Work Unit", {"mission": self.mission.name}), 1)
        self.assertEqual(frappe.db.count("Muster Run", {"mission": self.mission.name}), 2)
        self.mission.reload()
        self.assertEqual(self.mission.status, "Completed")
        self.assertEqual(self.mission.root_run_id, snapshot["rootRunId"])

    def test_wrong_authority_or_secret_payload_has_zero_projection_side_effects(self):
        snapshot = self._snapshot()
        snapshot["events"][-1]["payload"] = {"api_secret": "must-not-project"}
        with self.assertRaises(ProjectionError):
            project_gateway_snapshot(self.mission.name, snapshot, self.binding)
        self.assertEqual(frappe.db.count("Muster Activity", {"mission": self.mission.name}), 0)
        self.assertEqual(frappe.db.count("Muster Work Unit", {"mission": self.mission.name}), 0)
        self.assertEqual(frappe.db.count("Muster Run", {"mission": self.mission.name}), 0)
        self.mission.reload()
        self.assertEqual(self.mission.status, "Queued")

    def test_retry_attempt_numbers_follow_event_order_and_active_retry_is_running(self):
        snapshot = self._snapshot()
        admission, first_start, first_lease = snapshot["events"][:3]
        first_failure = {
            **snapshot["events"][3],
            "id": f"event-{snapshot['rootRunId']}-4-failed",
            "type": "node_failed",
            "summary": "First governed attempt failed",
        }
        second_start = {
            **first_start,
            "id": f"event-{snapshot['rootRunId']}-5-retry",
            "sequence": 5,
            "attemptId": "attempt-2",
            "summary": "Started verified retry",
        }
        snapshot.update(
            status="running",
            nextSequence=6,
            events=[admission, first_start, first_lease, first_failure, second_start],
            nodes=[
                {
                    "nodeId": "verify",
                    "status": "running",
                    "attemptId": "attempt-2",
                    "fencingToken": 2,
                }
            ],
        )

        project_gateway_snapshot(self.mission.name, snapshot, self.binding)

        runs = frappe.get_all(
            "Muster Run",
            filters={"mission": self.mission.name, "work_unit": ["is", "set"]},
            fields=["external_run_id", "attempt", "status"],
            order_by="attempt asc",
        )
        self.assertEqual([row.attempt for row in runs], [1, 2])
        self.assertEqual([row.status for row in runs], ["Failed", "Running"])
        work_unit = frappe.get_doc(
            "Muster Work Unit",
            frappe.db.get_value("Muster Work Unit", {"mission": self.mission.name}),
        )
        self.assertEqual(work_unit.attempt_count, 2)
        self.assertEqual(work_unit.status, "Running")
        self.assertEqual(work_unit.attempt_id, "attempt-2")


if __name__ == "__main__":
    unittest.main()
