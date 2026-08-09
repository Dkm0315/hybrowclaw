from __future__ import annotations

import json
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any

ALLOWED_OPERATIONS = {
    "create_record", "update_record", "delete_record", "submit_record", "cancel_record", "apply_workflow",
    "create_custom_field", "set_property", "create_workflow", "create_workspace", "create_page",
    "create_web_page", "create_web_form", "create_report", "create_print_format",
    "create_dashboard",
    "create_chart", "create_number_card", "create_notification", "create_assignment_rule",
    "create_webhook", "create_email_template", "create_letter_head", "install_fixture",
    "create_client_script", "create_server_script",
}
CODE_BEARING_OPERATIONS = {
    "create_page", "create_report", "create_print_format", "create_web_page",
    "create_client_script", "create_server_script", "create_notification",
    "create_assignment_rule", "create_webhook", "install_fixture",
}
APPROVAL_CLASSES = {"None", "Standard", "Sensitive", "Privileged Code", "Destructive"}
NAME_REQUIRED_OPERATIONS = {
    "update_record", "delete_record", "submit_record", "cancel_record", "apply_workflow", "set_property",
}
MAX_OPERATIONS = 250
MAX_VALUES_BYTES = 256_000


class ChangeValidationError(ValueError):
    pass


@dataclass(frozen=True)
class ChangeOperation:
    operation_id: str
    kind: str
    target_doctype: str
    target_name: str | None = None
    values: dict[str, Any] = field(default_factory=dict)
    idempotency_key: str = ""
    concurrency_token: str | None = None
    depends_on: tuple[str, ...] = ()
    approval_class: str = "Standard"

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ChangeOperation":
        return cls(
            operation_id=value.get("operation_id", ""), kind=value.get("kind", ""),
            target_doctype=value.get("target_doctype", ""), target_name=value.get("target_name"),
            values=value.get("values") or {}, idempotency_key=value.get("idempotency_key", ""),
            concurrency_token=value.get("concurrency_token"),
            depends_on=tuple(value.get("depends_on") or ()),
            approval_class=value.get("approval_class", "Standard"),
        )

    def validate(self) -> None:
        if not self.operation_id or not self.idempotency_key:
            raise ChangeValidationError("operation_id and idempotency_key are required")
        if self.kind not in ALLOWED_OPERATIONS:
            raise ChangeValidationError(f"unsupported operation: {self.kind}")
        if not self.target_doctype or len(self.target_doctype) > 140:
            raise ChangeValidationError("invalid target_doctype")
        if self.target_name is not None and len(self.target_name) > 140:
            raise ChangeValidationError("invalid target_name")
        if self.kind in NAME_REQUIRED_OPERATIONS and not self.target_name:
            raise ChangeValidationError(f"target_name is required for {self.kind}")
        if not isinstance(self.values, dict):
            raise ChangeValidationError("operation values must be an object")
        if any(not isinstance(key, str) or key.startswith("_") for key in self.values):
            raise ChangeValidationError("operation values contain a reserved field")
        if len(json.dumps(self.values, default=str).encode()) > MAX_VALUES_BYTES:
            raise ChangeValidationError("operation values exceed the safe size limit")
        if self.approval_class not in APPROVAL_CLASSES:
            raise ChangeValidationError("invalid approval class")
        if self.kind in CODE_BEARING_OPERATIONS and self.approval_class != "Privileged Code":
            raise ChangeValidationError("code-bearing changes require Privileged Code approval")


@dataclass(frozen=True)
class ChangeSet:
    schema_version: str
    target_site: str
    actor: str
    permission_epoch: str
    operations: tuple[ChangeOperation, ...]
    plan_hash: str = ""

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ChangeSet":
        return cls(
            schema_version=value.get("schema_version", ""),
            target_site=value.get("target_site", ""),
            actor=value.get("actor", ""), permission_epoch=value.get("permission_epoch", ""),
            operations=tuple(
                ChangeOperation.from_dict(item) for item in value.get("operations") or ()
            ),
            plan_hash=value.get("plan_hash", ""),
        )

    def canonical_hash(self) -> str:
        payload = {
            "schema_version": self.schema_version, "target_site": self.target_site,
            "actor": self.actor, "permission_epoch": self.permission_epoch,
            "operations": [op.__dict__ for op in self.operations],
        }
        serialized = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), default=list
        ).encode()
        return sha256(serialized).hexdigest()

    def validate(self) -> None:
        if self.schema_version != "1.0":
            raise ChangeValidationError("unsupported change-set schema version")
        if not self.target_site or not self.actor or not self.permission_epoch:
            raise ChangeValidationError("target_site, actor and permission_epoch are required")
        if not self.operations:
            raise ChangeValidationError("at least one operation is required")
        if len(self.operations) > MAX_OPERATIONS:
            raise ChangeValidationError("change set exceeds the operation limit")
        ids = {op.operation_id for op in self.operations}
        if len(ids) != len(self.operations):
            raise ChangeValidationError("operation ids must be unique")
        for op in self.operations:
            op.validate()
            if not set(op.depends_on).issubset(ids):
                raise ChangeValidationError("dependency references an unknown operation")
            if op.operation_id in op.depends_on:
                raise ChangeValidationError("an operation cannot depend on itself")
        if len({op.idempotency_key for op in self.operations}) != len(self.operations):
            raise ChangeValidationError("operation idempotency keys must be unique")
        self.topological_operations()
        if self.plan_hash and self.plan_hash != self.canonical_hash():
            raise ChangeValidationError("plan hash mismatch")

    def topological_operations(self) -> tuple[ChangeOperation, ...]:
        """Return a stable dependency order and reject cycles before any effect occurs."""
        by_id = {operation.operation_id: operation for operation in self.operations}
        remaining = {operation.operation_id: set(operation.depends_on) for operation in self.operations}
        ordered: list[ChangeOperation] = []
        while remaining:
            ready = [operation_id for operation_id, dependencies in remaining.items() if not dependencies]
            if not ready:
                raise ChangeValidationError("operation dependency graph contains a cycle")
            for operation_id in ready:
                ordered.append(by_id[operation_id])
                remaining.pop(operation_id)
                for dependencies in remaining.values():
                    dependencies.discard(operation_id)
        return tuple(ordered)

    def safe_summary(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version, "target_site": self.target_site,
            "operation_count": len(self.operations),
            "kinds": sorted({op.kind for op in self.operations}),
            "plan_hash": self.canonical_hash(),
        }
