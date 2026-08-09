from __future__ import annotations

import os
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from muster.orchestration.development import (
    DevelopmentSecurityError,
    MAX_PATCH_BYTES,
    apply_reviewed_patch,
    generate_reviewed_patch,
    run_offline_codex,
    rollback_reviewed_patch,
    source_snapshot,
    validate_patch,
)


def git(root: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(root), *args], check=True, stdout=subprocess.PIPE).stdout


class DevelopmentSecurityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve() / "registered_app"
        (self.root / "muster").mkdir(parents=True)
        (self.root / "muster" / "feature.py").write_text("VALUE = 1\n")
        (self.root / "pyproject.toml").write_text("[project]\nname='registered_app'\n")
        git(self.root, "init", "--quiet")
        git(self.root, "config", "user.email", "tests@example.invalid")
        git(self.root, "config", "user.name", "Tests")
        git(self.root, "add", ".")
        git(self.root, "commit", "--quiet", "-m", "baseline")
        self.snapshot = source_snapshot("registered_app", self.root)
        self.allowed = ("muster/**", "pyproject.toml")

    def tearDown(self):
        self.temporary.cleanup()

    def test_generation_exports_revision_and_never_touches_registered_source(self):
        before = (self.root / "muster" / "feature.py").read_bytes()

        def runner(workspace: Path, _prompt: str) -> None:
            (workspace / "muster" / "feature.py").write_text("VALUE = 2\n")
            (workspace / "muster" / "test_feature.py").write_text("def test_value():\n    assert 2 == 2\n")

        result = generate_reviewed_patch(self.snapshot, "Change the feature safely", self.allowed, runner)
        self.assertEqual((self.root / "muster" / "feature.py").read_bytes(), before)
        self.assertEqual(source_snapshot("registered_app", self.root), self.snapshot)
        self.assertEqual(result.changed_files, ("muster/feature.py", "muster/test_feature.py"))
        self.assertIn(b'"execution":"not_run"', result.test_manifest)
        self.assertIn(b"diff --git a/muster/feature.py", result.patch)

    def test_apply_is_separate_revision_locked_gate_and_does_not_deploy(self):
        def runner(workspace: Path, _prompt: str) -> None:
            (workspace / "muster" / "feature.py").write_text("VALUE = 3\n")

        generated = generate_reviewed_patch(self.snapshot, "Change one value", self.allowed, runner)
        evidence = apply_reviewed_patch(
            self.snapshot, generated.patch, generated.patch_hash, self.allowed,
            Path(self.temporary.name) / "locks" / "apply.lock",
        )
        self.assertRegex(evidence, r"^[a-f0-9]{64}$")
        self.assertEqual((self.root / "muster" / "feature.py").read_text(), "VALUE = 3\n")
        self.assertTrue(git(self.root, "status", "--porcelain").strip())

    def test_rollback_reverses_only_the_exact_applied_patch(self):
        def runner(workspace: Path, _prompt: str) -> None:
            (workspace / "muster" / "feature.py").write_text("VALUE = 7\n")

        generated = generate_reviewed_patch(self.snapshot, "Change one value", self.allowed, runner)
        lock = Path(self.temporary.name) / "rollback.lock"
        apply_reviewed_patch(self.snapshot, generated.patch, generated.patch_hash, self.allowed, lock)
        evidence = rollback_reviewed_patch(
            self.snapshot, generated.patch, generated.patch_hash, self.allowed, lock,
        )
        self.assertRegex(evidence, r"^[a-f0-9]{64}$")
        self.assertEqual((self.root / "muster" / "feature.py").read_text(), "VALUE = 1\n")
        self.assertFalse(git(self.root, "status", "--porcelain").strip())

    def test_rollback_refuses_post_apply_drift(self):
        def runner(workspace: Path, _prompt: str) -> None:
            (workspace / "muster" / "feature.py").write_text("VALUE = 8\n")

        generated = generate_reviewed_patch(self.snapshot, "Change one value", self.allowed, runner)
        lock = Path(self.temporary.name) / "rollback-drift.lock"
        apply_reviewed_patch(self.snapshot, generated.patch, generated.patch_hash, self.allowed, lock)
        (self.root / "muster" / "feature.py").write_text("human edit after apply\n")
        with self.assertRaises(DevelopmentSecurityError):
            rollback_reviewed_patch(
                self.snapshot, generated.patch, generated.patch_hash, self.allowed, lock,
            )
        self.assertEqual((self.root / "muster" / "feature.py").read_text(), "human edit after apply\n")

    def test_apply_and_rollback_cover_new_files(self):
        def runner(workspace: Path, _prompt: str) -> None:
            (workspace / "muster" / "new_api.py").write_text("VALUE = 'new'\n")

        generated = generate_reviewed_patch(self.snapshot, "Add one API file", self.allowed, runner)
        lock = Path(self.temporary.name) / "new-file.lock"
        apply_reviewed_patch(self.snapshot, generated.patch, generated.patch_hash, self.allowed, lock)
        self.assertEqual((self.root / "muster" / "new_api.py").read_text(), "VALUE = 'new'\n")
        self.assertIn(b"A  muster/new_api.py", git(self.root, "status", "--porcelain"))
        rollback_reviewed_patch(self.snapshot, generated.patch, generated.patch_hash, self.allowed, lock)
        self.assertFalse((self.root / "muster" / "new_api.py").exists())
        self.assertFalse(git(self.root, "status", "--porcelain").strip())

    def test_generation_rejects_symlinks_binary_secrets_generated_and_outside_paths(self):
        hostile = {
            "symlink": lambda workspace: (workspace / "muster" / "escape").symlink_to("/etc/passwd"),
            "binary": lambda workspace: (workspace / "muster" / "payload.bin").write_bytes(b"abc\x00def"),
            "secret": lambda workspace: (workspace / "muster" / ".env").write_text("API_KEY=super-secret-value-12345\n"),
            "generated": lambda workspace: ((workspace / "node_modules").mkdir(), (workspace / "node_modules" / "x.js").write_text("x")),
            "outside": lambda workspace: (workspace / "README.md").write_text("outside registered paths\n"),
        }
        for label, mutate in hostile.items():
            with self.subTest(label=label):
                with self.assertRaises(DevelopmentSecurityError):
                    generate_reviewed_patch(self.snapshot, "Hostile change", self.allowed, lambda workspace, _prompt: mutate(workspace))
                self.assertEqual(source_snapshot("registered_app", self.root), self.snapshot)

    def test_patch_parser_rejects_traversal_binary_secret_and_large_diff(self):
        hostile = [
            b"diff --git a/../escape b/../escape\n--- a/../escape\n+++ b/../escape\n+bad\n",
            b"diff --git a/muster/a.bin b/muster/a.bin\nGIT binary patch\n",
            b"diff --git a/muster/x.py b/muster/x.py\n--- a/muster/x.py\n+++ b/muster/x.py\n+api_key='abcdefghijklmnop'\n",
            b"diff --git a/muster/x.py b/muster/x.py\n--- ../../escape\n+++ b/muster/x.py\n+bad\n",
            b"diff --git a/muster/link b/muster/link\nnew file mode 120000\n--- /dev/null\n+++ b/muster/link\n+../../escape\n",
            b"x" * (MAX_PATCH_BYTES + 1),
        ]
        for candidate in hostile:
            with self.assertRaises(DevelopmentSecurityError):
                validate_patch(candidate, self.allowed)

    def test_source_drift_blocks_apply_before_any_write(self):
        def runner(workspace: Path, _prompt: str) -> None:
            (workspace / "muster" / "feature.py").write_text("VALUE = 4\n")

        generated = generate_reviewed_patch(self.snapshot, "Change one value", self.allowed, runner)
        (self.root / "muster" / "feature.py").write_text("user work\n")
        with self.assertRaises(DevelopmentSecurityError):
            apply_reviewed_patch(
                self.snapshot, generated.patch, generated.patch_hash, self.allowed,
                Path(self.temporary.name) / "apply.lock",
            )
        self.assertEqual((self.root / "muster" / "feature.py").read_text(), "user work\n")

    def test_codex_runner_uses_isolated_home_offline_workspace_and_no_mcp_config(self):
        source_home = Path(self.temporary.name) / "operator-codex"
        source_home.mkdir()
        (source_home / "auth.json").write_text('{"token":"test-only"}')
        completed = Mock(returncode=0, stdout=b"", stderr=b"")
        with (
            patch.dict(os.environ, {"CODEX_HOME": str(source_home)}, clear=False),
            patch("muster.orchestration.development.shutil.which", return_value="/trusted/bin/codex"),
            patch("muster.orchestration.development.subprocess.run", return_value=completed) as run,
        ):
            run_offline_codex(self.root, "safe prompt", timeout_seconds=5)
        command = run.call_args.args[0]
        environment = run.call_args.kwargs["env"]
        self.assertIn("sandbox_workspace_write.network_access=false", command)
        self.assertIn("--ignore-rules", command)
        self.assertEqual(command[command.index("-s") + 1], "workspace-write")
        self.assertNotEqual(environment["CODEX_HOME"], str(source_home))
        self.assertFalse(Path(environment["CODEX_HOME"]).exists())
        self.assertNotIn("OPENAI_API_KEY", environment)

    def test_nested_registered_app_applies_only_below_its_reviewed_root(self):
        repository = Path(self.temporary.name).resolve() / "monorepo"
        app = repository / "apps" / "nested_app"
        (app / "nested_app").mkdir(parents=True)
        (app / "nested_app" / "hooks.py").write_text("VALUE = 1\n")
        git(repository, "init", "--quiet")
        git(repository, "config", "user.email", "tests@example.invalid")
        git(repository, "config", "user.name", "Tests")
        git(repository, "add", ".")
        git(repository, "commit", "--quiet", "-m", "nested baseline")
        snapshot = source_snapshot("nested_app", app)

        def runner(workspace: Path, _prompt: str) -> None:
            (workspace / "nested_app" / "hooks.py").write_text("VALUE = 9\n")

        generated = generate_reviewed_patch(snapshot, "Edit the nested app", ("nested_app/**",), runner)
        apply_reviewed_patch(
            snapshot, generated.patch, generated.patch_hash, ("nested_app/**",),
            Path(self.temporary.name) / "nested.lock",
        )
        self.assertEqual((app / "nested_app" / "hooks.py").read_text(), "VALUE = 9\n")
        self.assertFalse((repository / "nested_app").exists())

    def test_registered_source_path_with_symlink_component_is_rejected(self):
        link = Path(self.temporary.name).resolve() / "linked-app"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(DevelopmentSecurityError):
            source_snapshot("registered_app", link)

    def test_coding_ladder_covers_framework_native_code_without_page_bias(self):
        fixture_root = Path(__file__).parents[1] / "demo" / "fixtures"
        scenario = json.loads((fixture_root / "frappeverse_coding_ladder_scenario.json").read_text())
        prd_lines = (fixture_root / scenario["source_file"]).read_text().splitlines()
        for requirement in scenario["requirements"]:
            line = prd_lines[int(requirement["locator"].split(":")[1]) - 1].strip()
            self.assertTrue(line.startswith("-"), requirement)
        classifications = {row["classification"] for row in scenario["requirements"]}
        self.assertTrue({
            "metadata-js-jinja", "document-lifecycle-code", "orm-query-builder-api",
            "existing-form-list-javascript", "migration-background-work",
            "jinja-rendering", "apply-verify-rollback",
        }.issubset(classifications))
        encoded = json.dumps(scenario)
        for expected in (
            "doc_events", "frappe.get_list", "Query Builder", "frappe.ui.form.on",
            "Email Template", "before_insert", "on_update", "enqueue-after-commit",
            "MariaDB", "unsafe Jinja",
        ):
            self.assertIn(expected, encoded)
        self.assertNotIn("page/service_operations", encoded)


if __name__ == "__main__":
    unittest.main()
