#!/usr/bin/env python3
"""Behavioral tests for the stable-release evidence validator."""

from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import ModuleType


PROJECT_ROOT = Path(__file__).resolve().parents[2]
VALIDATOR_PATH = PROJECT_ROOT / "scripts" / "validate_release_readiness.py"
FIXED_NOW = dt.datetime(2026, 7, 26, tzinfo=dt.timezone.utc)


def _load_validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "validate_release_readiness",
        VALIDATOR_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to import {VALIDATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = _load_validator()


class ReleaseReadinessValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repository = Path(self.temp_dir.name)
        self._git("init", "-q", "-b", "main")
        self._git("config", "user.name", "Release Gate Test")
        self._git("config", "user.email", "release-gate@example.invalid")
        (self.repository / ".github").mkdir()
        (self.repository / "app.txt").write_text("candidate\n", encoding="utf-8")
        self._write_manifest(self._disabled_manifest())
        self._git("add", ".")
        self._git("commit", "-q", "-m", "candidate source")
        self.source_commit = self._git("rev-parse", "HEAD")

        self.artifacts = {
            f"https://evidence.example/{evidence_id}": f"artifact:{evidence_id}".encode()
            for evidence_id in validator.REQUIRED_EXTERNAL_EVIDENCE
        }

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _git(self, *args: str) -> str:
        completed = subprocess.run(
            ["git", *args],
            cwd=self.repository,
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()

    @staticmethod
    def _disabled_manifest() -> dict[str, object]:
        return {
            "schema_version": 2,
            "evidence_binding": validator.EVIDENCE_BINDING,
            "stable_publication_enabled": False,
            "status": "production-readiness-candidate",
            "reason": "Test fixture remains disabled.",
            "required_external_evidence": list(
                validator.REQUIRED_EXTERNAL_EVIDENCE
            ),
            "external_evidence": {},
        }

    def _enabled_manifest(self) -> dict[str, object]:
        records = {}
        for evidence_id in validator.REQUIRED_EXTERNAL_EVIDENCE:
            url = f"https://evidence.example/{evidence_id}"
            records[evidence_id] = {
                "status": "passed",
                "url": url,
                "artifact_sha256": hashlib.sha256(self.artifacts[url]).hexdigest(),
                "assessed_source_commit": self.source_commit,
                "valid_until": "2099-01-01T00:00:00Z",
            }
        return {
            "schema_version": 2,
            "evidence_binding": validator.EVIDENCE_BINDING,
            "stable_publication_enabled": True,
            "status": "stable-release-approved",
            "reason": "All external evidence passed.",
            "required_external_evidence": list(
                validator.REQUIRED_EXTERNAL_EVIDENCE
            ),
            "external_evidence": records,
        }

    def _write_manifest(self, manifest: dict[str, object]) -> None:
        path = self.repository / validator.MANIFEST_PATH
        path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    def _commit_approval(
        self,
        manifest: dict[str, object],
        *,
        extra_change: tuple[str, str] | None = None,
    ) -> str:
        self._write_manifest(manifest)
        if extra_change is not None:
            relative_path, content = extra_change
            path = self.repository / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        self._git("add", ".")
        self._git("commit", "-q", "-m", "approve stable release")
        return self._git("rev-parse", "HEAD")

    def _fetch(self, url: str) -> bytes:
        return self.artifacts[url]

    def _validate(self, release_commit: str, fetch=None) -> str:
        return validator.validate_release_readiness(
            self.repository,
            release_commit,
            now=FIXED_NOW,
            fetch_artifact=fetch or self._fetch,
        )

    def test_valid_evidence_only_child_succeeds(self) -> None:
        release_commit = self._commit_approval(self._enabled_manifest())
        self.assertEqual(self._validate(release_commit), self.source_commit)

    def test_disabled_manifest_fails_closed(self) -> None:
        with self.assertRaisesRegex(
            validator.ReleaseReadinessError,
            "fail-closed",
        ):
            self._validate(self.source_commit)

    def test_source_or_workflow_change_in_approval_commit_fails(self) -> None:
        release_commit = self._commit_approval(
            self._enabled_manifest(),
            extra_change=(".github/workflows/publish.yml", "changed\n"),
        )
        with self.assertRaisesRegex(
            validator.ReleaseReadinessError,
            "modify only",
        ):
            self._validate(release_commit)

    def test_merge_approval_commit_fails(self) -> None:
        self._git("switch", "-q", "-c", "side", self.source_commit)
        self._git("commit", "-q", "--allow-empty", "-m", "side review")
        self._git("switch", "-q", "-c", "approval", self.source_commit)
        self._commit_approval(self._enabled_manifest())
        self._git("merge", "-q", "--no-ff", "side", "-m", "merge approval")
        merge_commit = self._git("rev-parse", "HEAD")

        with self.assertRaisesRegex(
            validator.ReleaseReadinessError,
            "non-merge commit",
        ):
            self._validate(merge_commit)

    def test_mismatched_source_commit_fails(self) -> None:
        manifest = self._enabled_manifest()
        first = validator.REQUIRED_EXTERNAL_EVIDENCE[0]
        manifest["external_evidence"][first]["assessed_source_commit"] = "0" * 40
        release_commit = self._commit_approval(manifest)
        with self.assertRaisesRegex(
            validator.ReleaseReadinessError,
            "exact source commit",
        ):
            self._validate(release_commit)

    def test_missing_record_fails(self) -> None:
        manifest = self._enabled_manifest()
        manifest["external_evidence"].pop(validator.REQUIRED_EXTERNAL_EVIDENCE[0])
        release_commit = self._commit_approval(manifest)
        with self.assertRaisesRegex(
            validator.ReleaseReadinessError,
            "exactly every required record",
        ):
            self._validate(release_commit)

    def test_expired_record_fails(self) -> None:
        manifest = self._enabled_manifest()
        first = validator.REQUIRED_EXTERNAL_EVIDENCE[0]
        manifest["external_evidence"][first]["valid_until"] = "2026-07-25T00:00:00Z"
        release_commit = self._commit_approval(manifest)
        with self.assertRaisesRegex(validator.ReleaseReadinessError, "expired"):
            self._validate(release_commit)

    def test_non_https_record_fails(self) -> None:
        manifest = self._enabled_manifest()
        first = validator.REQUIRED_EXTERNAL_EVIDENCE[0]
        manifest["external_evidence"][first]["url"] = "http://evidence.example/report"
        release_commit = self._commit_approval(manifest)
        with self.assertRaisesRegex(validator.ReleaseReadinessError, "HTTPS"):
            self._validate(release_commit)

    def test_unfetchable_record_fails(self) -> None:
        release_commit = self._commit_approval(self._enabled_manifest())

        def unavailable(_: str) -> bytes:
            raise OSError("network unavailable")

        with self.assertRaisesRegex(
            validator.ReleaseReadinessError,
            "Unable to download evidence",
        ):
            self._validate(release_commit, fetch=unavailable)

    def test_artifact_hash_mismatch_fails(self) -> None:
        manifest = self._enabled_manifest()
        first = validator.REQUIRED_EXTERNAL_EVIDENCE[0]
        manifest["external_evidence"][first]["artifact_sha256"] = "0" * 64
        release_commit = self._commit_approval(manifest)
        with self.assertRaisesRegex(
            validator.ReleaseReadinessError,
            "digest does not match",
        ):
            self._validate(release_commit)

    def test_reduced_required_set_fails(self) -> None:
        manifest = self._enabled_manifest()
        manifest["required_external_evidence"].pop()
        release_commit = self._commit_approval(manifest)
        with self.assertRaisesRegex(
            validator.ReleaseReadinessError,
            "requirements are incomplete",
        ):
            self._validate(release_commit)


if __name__ == "__main__":
    unittest.main()
