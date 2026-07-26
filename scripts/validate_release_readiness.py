#!/usr/bin/env python3
"""Validate Mosaic's stable-release evidence and source binding."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from pathlib import Path


MANIFEST_PATH = ".github/release-readiness.json"
EVIDENCE_BINDING = "direct-parent-source-commit"
MAX_EVIDENCE_BYTES = 64 * 1024 * 1024
REQUIRED_EXTERNAL_EVIDENCE = (
    "independent-cryptographic-review",
    "production-backup-restore-drill",
    "upgrade-and-rollback-drill",
    "named-hardware-performance-budgets",
    "firefox-webkit-opfs-durability-matrix",
    "real-proxyauth-boundary-test",
    "production-audit-persistence-test",
    "repository-governance-controls",
)


class ReleaseReadinessError(RuntimeError):
    """A fail-closed release-readiness validation error."""


def _git(repository: Path, *args: str) -> str:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=repository,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() or exc.stdout.strip() or "unknown Git error"
        raise ReleaseReadinessError(f"Git validation failed: {detail}") from exc
    return completed.stdout.strip()


def _release_source_commit(repository: Path, release_commit: str) -> tuple[str, str]:
    if not re.fullmatch(r"[0-9a-f]{40}", release_commit):
        raise ReleaseReadinessError("Release commit must be a full lowercase Git commit ID.")

    resolved_release = _git(
        repository,
        "rev-parse",
        "--verify",
        f"{release_commit}^{{commit}}",
    )
    if resolved_release != release_commit:
        raise ReleaseReadinessError("Release commit did not resolve to the expected commit.")

    ancestry = _git(repository, "rev-list", "--parents", "-n", "1", release_commit).split()
    if len(ancestry) != 2:
        raise ReleaseReadinessError(
            "Stable release approval must be a non-merge commit with exactly one parent."
        )
    source_commit = ancestry[1]

    changed = _git(
        repository,
        "diff",
        "--name-status",
        "--no-renames",
        source_commit,
        release_commit,
        "--",
    ).splitlines()
    if changed != [f"M\t{MANIFEST_PATH}"]:
        rendered = ", ".join(changed) if changed else "no files"
        raise ReleaseReadinessError(
            "Stable release approval must modify only "
            f"{MANIFEST_PATH}; observed: {rendered}."
        )

    tree_entry = _git(repository, "ls-tree", release_commit, "--", MANIFEST_PATH)
    if not tree_entry.startswith("100644 blob ") or not tree_entry.endswith(
        f"\t{MANIFEST_PATH}"
    ):
        raise ReleaseReadinessError(
            f"{MANIFEST_PATH} must be a regular non-executable file in the release tree."
        )

    return resolved_release, source_commit


def _manifest_at_commit(repository: Path, release_commit: str) -> Mapping[str, object]:
    raw = _git(repository, "show", f"{release_commit}:{MANIFEST_PATH}")
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ReleaseReadinessError(f"{MANIFEST_PATH} is not valid JSON.") from exc
    if not isinstance(manifest, dict):
        raise ReleaseReadinessError(f"{MANIFEST_PATH} must contain a JSON object.")
    return manifest


def _validate_https_url(url: str, *, resolve_host: bool) -> None:
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port or 443
    except ValueError as exc:
        raise ReleaseReadinessError(f"Evidence URL is malformed: {url}") from exc

    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ReleaseReadinessError(
            "Evidence URLs must be HTTPS URLs without credentials or fragments."
        )

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise ReleaseReadinessError("Evidence URLs must not target localhost.")

    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None and not literal.is_global:
        raise ReleaseReadinessError("Evidence URLs must use a public network address.")

    if not resolve_host:
        return

    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(
                hostname,
                port,
                type=socket.SOCK_STREAM,
            )
        }
    except OSError as exc:
        raise ReleaseReadinessError(
            f"Could not resolve evidence host {hostname}."
        ) from exc
    if not addresses:
        raise ReleaseReadinessError(f"Evidence host {hostname} resolved to no addresses.")
    for address in addresses:
        if not ipaddress.ip_address(address).is_global:
            raise ReleaseReadinessError(
                f"Evidence host {hostname} resolved to a non-public address."
            )


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> urllib.request.Request | None:
        _validate_https_url(newurl, resolve_host=True)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_evidence(url: str) -> bytes:
    """Download a bounded public HTTPS evidence artifact."""

    _validate_https_url(url, resolve_host=True)
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": "Mosaic-release-readiness/2",
        },
    )
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    try:
        with opener.open(request, timeout=30) as response:
            _validate_https_url(response.geturl(), resolve_host=True)
            content_length = response.headers.get("Content-Length")
            if content_length is not None and int(content_length) > MAX_EVIDENCE_BYTES:
                raise ReleaseReadinessError(
                    f"Evidence artifact exceeds {MAX_EVIDENCE_BYTES} bytes."
                )
            content = response.read(MAX_EVIDENCE_BYTES + 1)
    except ReleaseReadinessError:
        raise
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise ReleaseReadinessError(f"Unable to download evidence artifact: {url}") from exc
    if len(content) > MAX_EVIDENCE_BYTES:
        raise ReleaseReadinessError(
            f"Evidence artifact exceeds {MAX_EVIDENCE_BYTES} bytes."
        )
    return content


def validate_release_readiness(
    repository: Path,
    release_commit: str,
    *,
    now: dt.datetime | None = None,
    fetch_artifact: Callable[[str], bytes] = download_evidence,
    output_directory: Path | None = None,
) -> str:
    """Validate the release commit and return its assessed source commit."""

    manifest = _manifest_at_commit(repository, release_commit)
    required = manifest.get("required_external_evidence")
    if manifest.get("schema_version") != 2:
        raise ReleaseReadinessError("Release-readiness schema version must be 2.")
    if manifest.get("evidence_binding") != EVIDENCE_BINDING:
        raise ReleaseReadinessError(
            f"Release-readiness evidence_binding must be {EVIDENCE_BINDING!r}."
        )
    if (
        not isinstance(required, list)
        or len(required) != len(REQUIRED_EXTERNAL_EVIDENCE)
        or set(required) != set(REQUIRED_EXTERNAL_EVIDENCE)
    ):
        raise ReleaseReadinessError(
            "Release-readiness external evidence requirements are incomplete."
        )
    if manifest.get("stable_publication_enabled") is not True:
        raise ReleaseReadinessError(
            "Stable publication is fail-closed pending independent release evidence: "
            + ", ".join(REQUIRED_EXTERNAL_EVIDENCE)
        )

    _, source_commit = _release_source_commit(repository, release_commit)
    evidence = manifest.get("external_evidence")
    if not isinstance(evidence, dict) or set(evidence) != set(REQUIRED_EXTERNAL_EVIDENCE):
        raise ReleaseReadinessError(
            "Release-readiness external_evidence must contain exactly every required record."
        )

    instant = now or dt.datetime.now(dt.timezone.utc)
    if instant.tzinfo is None:
        raise ValueError("The validation clock must be timezone-aware.")
    if output_directory is not None:
        try:
            output_directory.mkdir(parents=True, exist_ok=False)
        except OSError as exc:
            raise ReleaseReadinessError(
                f"Unable to create evidence output directory {output_directory}."
            ) from exc

    for evidence_id in required:
        record = evidence[evidence_id]
        if not isinstance(record, dict) or record.get("status") != "passed":
            raise ReleaseReadinessError(f"Missing passed release evidence: {evidence_id}")

        url = str(record.get("url", ""))
        _validate_https_url(url, resolve_host=False)

        artifact_sha256 = str(record.get("artifact_sha256", ""))
        if not re.fullmatch(r"[0-9a-f]{64}", artifact_sha256):
            raise ReleaseReadinessError(
                f"Evidence {evidence_id} needs a lowercase SHA-256 artifact digest."
            )

        assessed_source_commit = str(record.get("assessed_source_commit", ""))
        if not re.fullmatch(r"[0-9a-f]{40}", assessed_source_commit):
            raise ReleaseReadinessError(
                f"Evidence {evidence_id} needs a full assessed source commit."
            )
        if assessed_source_commit != source_commit:
            raise ReleaseReadinessError(
                f"Evidence {evidence_id} does not assess the release's exact source commit."
            )

        try:
            valid_until = dt.datetime.fromisoformat(
                str(record.get("valid_until", "")).replace("Z", "+00:00")
            )
        except ValueError as exc:
            raise ReleaseReadinessError(
                f"Evidence {evidence_id} needs an ISO-8601 valid_until."
            ) from exc
        if valid_until.tzinfo is None or valid_until <= instant:
            raise ReleaseReadinessError(f"Evidence {evidence_id} is expired.")

        try:
            artifact = fetch_artifact(url)
        except ReleaseReadinessError:
            raise
        except Exception as exc:
            raise ReleaseReadinessError(
                f"Unable to download evidence {evidence_id}."
            ) from exc
        actual_sha256 = hashlib.sha256(artifact).hexdigest()
        if not hmac.compare_digest(actual_sha256, artifact_sha256):
            raise ReleaseReadinessError(
                f"Evidence {evidence_id} artifact digest does not match its manifest record."
            )
        if output_directory is not None:
            try:
                (output_directory / f"{evidence_id}.artifact").write_bytes(artifact)
            except OSError as exc:
                raise ReleaseReadinessError(
                    f"Unable to retain evidence artifact {evidence_id}."
                ) from exc

    if output_directory is not None:
        try:
            (output_directory / "release-readiness.json").write_text(
                json.dumps(manifest, indent=2) + "\n",
                encoding="utf-8",
            )
            (output_directory / "ASSESSED_SOURCE_COMMIT").write_text(
                source_commit + "\n",
                encoding="ascii",
            )
        except OSError as exc:
            raise ReleaseReadinessError("Unable to retain release evidence metadata.") from exc

    return source_commit


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repository",
        type=Path,
        default=Path("."),
        help="Git repository containing the tagged release tree",
    )
    parser.add_argument(
        "--release-commit",
        required=True,
        help="Full peeled commit ID of the annotated stable tag",
    )
    parser.add_argument(
        "--output-directory",
        type=Path,
        help="New directory in which verified evidence artifacts will be retained",
    )
    args = parser.parse_args(argv)

    try:
        source_commit = validate_release_readiness(
            args.repository.resolve(),
            args.release_commit,
            output_directory=(
                args.output_directory.resolve()
                if args.output_directory is not None
                else None
            ),
        )
    except ReleaseReadinessError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1

    print(
        "Stable release evidence verified for source commit "
        f"{source_commit}; the tagged child changes only {MANIFEST_PATH}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
