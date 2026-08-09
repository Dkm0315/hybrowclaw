import unittest

from muster.change_ir.schema import ChangeSet, ChangeValidationError


class TestChangeSet(unittest.TestCase):
    def payload(self):
        return {
            "schema_version": "1.0",
            "target_site": "site.test",
            "actor": "user@example.com",
            "permission_epoch": "p1",
            "operations": [
                {
                    "operation_id": "op-1",
                    "kind": "update_record",
                    "target_doctype": "ToDo",
                    "target_name": "TODO-1",
                    "values": {"status": "Closed"},
                    "idempotency_key": "idem-1",
                }
            ],
        }

    def test_valid_change_set(self):
        change_set = ChangeSet.from_dict(self.payload())
        change_set.validate()
        self.assertEqual(change_set.safe_summary()["operation_count"], 1)

    def test_arbitrary_operation_is_rejected(self):
        payload = self.payload()
        payload["operations"][0]["kind"] = "execute_arbitrary_python"
        with self.assertRaises(ChangeValidationError):
            ChangeSet.from_dict(payload).validate()

    def test_code_surface_requires_privileged_approval(self):
        payload = self.payload()
        payload["operations"][0]["kind"] = "create_page"
        with self.assertRaises(ChangeValidationError):
            ChangeSet.from_dict(payload).validate()

    def test_cycles_are_rejected_before_execution(self):
        payload = self.payload()
        payload["operations"] = [
            {**payload["operations"][0], "operation_id": "one", "idempotency_key": "one", "depends_on": ["two"]},
            {**payload["operations"][0], "operation_id": "two", "idempotency_key": "two", "depends_on": ["one"]},
        ]
        with self.assertRaises(ChangeValidationError):
            ChangeSet.from_dict(payload).validate()

    def test_duplicate_effect_keys_are_rejected(self):
        payload = self.payload()
        payload["operations"].append({**payload["operations"][0], "operation_id": "op-2"})
        with self.assertRaises(ChangeValidationError):
            ChangeSet.from_dict(payload).validate()
