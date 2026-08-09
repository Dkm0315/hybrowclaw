import unittest

from muster.policy.engine import evaluate


class TestPolicy(unittest.TestCase):
    def test_default_deny(self):
        decision = evaluate(
            capabilities=[], requested="record.write", frappe_allowed=True
        )
        self.assertFalse(decision.allowed)

    def test_frappe_permission_is_mandatory(self):
        result = evaluate(
            capabilities=["record.write"], requested="record.write", frappe_allowed=False
        )
        self.assertEqual(result.reason, "frappe-permission-denied")

    def test_explicit_deny_wins(self):
        result = evaluate(
            capabilities=["*"],
            requested="metadata.write",
            frappe_allowed=True,
            explicitly_denied=["metadata.write"],
        )
        self.assertFalse(result.allowed)
