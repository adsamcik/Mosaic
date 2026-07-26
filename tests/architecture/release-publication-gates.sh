#!/usr/bin/env bash
# Stable release tags require complete assurance and verified digest evidence.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

python3 - <<'PY'
from pathlib import Path
import json
import re

publish = Path(".github/workflows/publish.yml").read_text(encoding="utf-8")
tests = Path(".github/workflows/tests.yml").read_text(encoding="utf-8")
readiness = json.loads(Path(".github/release-readiness.json").read_text(encoding="utf-8"))
smoke = Path("tests/e2e/tests/smoke.spec.ts").read_text(encoding="utf-8")
validator = Path("scripts/validate_release_readiness.py").read_text(encoding="utf-8")
validator_tests = Path("tests/architecture/test_release_readiness.py").read_text(encoding="utf-8")

expected_external = {
    "independent-cryptographic-review",
    "production-backup-restore-drill",
    "upgrade-and-rollback-drill",
    "named-hardware-performance-budgets",
    "firefox-webkit-opfs-durability-matrix",
    "real-proxyauth-boundary-test",
    "production-audit-persistence-test",
    "repository-governance-controls",
}
if readiness.get("schema_version") != 2:
    raise SystemExit("release-publication-gates: release-readiness schema version must be 2")
if readiness.get("evidence_binding") != "direct-parent-source-commit":
    raise SystemExit("release-publication-gates: release-readiness evidence binding is unsafe")
if set(readiness.get("required_external_evidence", [])) != expected_external:
    raise SystemExit("release-publication-gates: release-readiness external evidence set is incomplete")
if not isinstance(readiness.get("stable_publication_enabled"), bool):
    raise SystemExit("release-publication-gates: stable publication flag must be an explicit boolean")

forbidden = (
    "skip_e2e_only",
    "bypass_reason",
    "validate-bypass",
    "needs.e2e-tests.result == 'skipped'",
    "e2e-bypassed",
    "  android-release:",
    "type=raw,value=latest",
    "type=semver,pattern={{major}}",
)
for token in forbidden:
    if token in publish:
        raise SystemExit(f"release-publication-gates: forbidden stable-publication token: {token}")

required_publish = (
    "github.event.deleted == false",
    "Require an exact annotated stable SemVer tag on main",
    'git cat-file -t "refs/tags/$GITHUB_REF_NAME"',
    'git rev-parse "refs/tags/$GITHUB_REF_NAME^{commit}"',
    "Stable publication requires an annotated release tag",
    'git merge-base --is-ancestor "$release_commit" FETCH_HEAD',
    "commit: ${{ steps.release.outputs.commit }}",
    "EXPECTED_COMMIT: ${{ needs.release-contract.outputs.commit }}",
    'test "$revision" = "$EXPECTED_COMMIT"',
    "scripts/validate_release_readiness.py",
    '--release-commit "$RELEASE_COMMIT"',
    '--output-directory "$RUNNER_TEMP/release-evidence"',
    "Retain verified external evidence for release attachment",
    "release-evidence-${{ steps.release.outputs.commit }}",
    "actions/upload-artifact@",
    "uses: ./.github/workflows/tests.yml",
    "release_assurance: true",
    "include_android: false",
    "needs.assurance.result == 'success'",
    "provenance: mode=max",
    "sbom: true",
    "actions/attest-build-provenance@",
    "push-to-registry: true",
    "gh attestation verify",
    "docker buildx imagetools inspect \"$subject\" --format '{{ json .SBOM }}'",
    "docker pull \"$BACKEND_SUBJECT\"",
    "docker pull \"$FRONTEND_SUBJECT\"",
    "org.opencontainers.image.revision",
    "org.opencontainers.image.version",
    "up -d --no-build postgres backend frontend",
    "needs.clean-consumer.result == 'success'",
    "Refusing to move existing stable tag",
    "Unable to determine whether stable tag",
    "needs.promote-stable-tags.result == 'success'",
    "Digest-Bound GitHub Release",
)
for token in required_publish:
    if token not in publish:
        raise SystemExit(f"release-publication-gates: missing publication guarantee: {token}")

if publish.count("provenance: mode=max") != 2:
    raise SystemExit("release-publication-gates: both Docker candidates need maximal provenance")
if publish.count("sbom: true") != 2:
    raise SystemExit("release-publication-gates: both Docker candidates need registry SBOMs")
if publish.count("actions/attest-build-provenance@") != 2:
    raise SystemExit("release-publication-gates: both Docker digests need signed GitHub provenance")

required_validator = (
    'EVIDENCE_BINDING = "direct-parent-source-commit"',
    '"repository-governance-controls"',
    '"rev-list", "--parents", "-n", "1"',
    "non-merge commit with exactly one parent",
    '"diff",',
    "Stable release approval must modify only",
    '"100644 blob "',
    "stable_publication_enabled",
    "external_evidence",
    "artifact_sha256",
    "assessed_source_commit",
    "does not assess the release's exact source commit",
    "valid_until",
    "MAX_EVIDENCE_BYTES",
    "Evidence URLs must be HTTPS URLs without credentials or fragments",
    "resolved to a non-public address",
    "artifact digest does not match its manifest record",
)
for token in required_validator:
    if token not in validator:
        raise SystemExit(f"release-publication-gates: evidence validator lacks: {token}")
if "assessed_commit" in publish or "assessed_commit" in validator:
    raise SystemExit("release-publication-gates: self-referential assessed_commit binding is forbidden")

required_behavioral_tests = (
    "test_valid_evidence_only_child_succeeds",
    "test_disabled_manifest_fails_closed",
    "test_source_or_workflow_change_in_approval_commit_fails",
    "test_merge_approval_commit_fails",
    "test_mismatched_source_commit_fails",
    "test_missing_record_fails",
    "test_expired_record_fails",
    "test_non_https_record_fails",
    "test_unfetchable_record_fails",
    "test_artifact_hash_mismatch_fails",
    "test_reduced_required_set_fails",
)
for token in required_behavioral_tests:
    if token not in validator_tests:
        raise SystemExit(f"release-publication-gates: evidence behavior coverage lacks: {token}")

if publish.count("      packages: write\n") != 3:
    raise SystemExit("release-publication-gates: publication permissions contain missing or duplicate package writers")
if publish.count("      FRONTEND_REPOSITORY:") != 2:
    raise SystemExit("release-publication-gates: frontend repository environment keys are missing or duplicated")
if publish.count("org.opencontainers.image.revision=${{ needs.release-contract.outputs.commit }}") != 2:
    raise SystemExit("release-publication-gates: both OCI candidates must label the peeled release commit")

assurance_start = publish.index("  assurance:\n")
assurance_end = publish.index("\n  build-backend-candidate:\n", assurance_start)
assurance = publish[assurance_start:assurance_end]
for token in ("needs: release-contract", "uses: ./.github/workflows/tests.yml", "release_assurance: true"):
    if token not in assurance:
        raise SystemExit(f"release-publication-gates: tagged assurance is incomplete: {token}")

consumer_start = publish.index("  clean-consumer:\n")
promotion_start = publish.index("  promote-stable-tags:\n")
release_start = publish.index("  release:\n", promotion_start)
android_detect_start = publish.index("  detect-android-preview-secrets:\n")
android_start = publish.index("  android-preview:\n")
consumer = publish[consumer_start:promotion_start]
promotion = publish[promotion_start:release_start]
release = publish[release_start:android_detect_start]

for token in (
    "build-backend-candidate",
    "build-frontend-candidate",
    "gh attestation verify",
    "spdxVersion",
    "buildType",
    "docker image inspect",
    "http://localhost:5000/health",
    "http://localhost:8080/health",
    "image: $BACKEND_SUBJECT",
    "image: $FRONTEND_SUBJECT",
    "npx playwright install --with-deps chromium",
    "npx playwright test --project=smoke --reporter=list",
    "BASE_URL: http://localhost:8080",
    "API_URL: http://localhost:5000",
):
    if token not in consumer:
        raise SystemExit(f"release-publication-gates: clean consumer lacks: {token}")
if consumer.count("working-directory: tests/e2e") < 2:
    raise SystemExit("release-publication-gates: exact-image smoke dependencies and test must run from tests/e2e")
if consumer.index("up -d --no-build postgres backend frontend") > consumer.index("npx playwright test --project=smoke"):
    raise SystemExit("release-publication-gates: exact candidate images must start before the smoke journey")
for token in (
    "SMOKE-1: can register and initialize crypto",
    "SMOKE-2: can create an album",
    "SMOKE-3: can upload a photo to album",
    "SMOKE-4: uploaded photo persists after a full page reload",
    "page.reload({ waitUntil: 'domcontentloaded' })",
    "SMOKE-6: can logout and session is cleared",
):
    if token not in smoke:
        raise SystemExit(f"release-publication-gates: exact-image smoke journey lacks: {token}")

for token in ("clean-consumer", "imagetools create", "existing stable tag", "actual\" != \"$expected"):
    if token not in promotion:
        raise SystemExit(f"release-publication-gates: stable promotion lacks: {token}")
if "promote-stable-tags" not in release or "android-preview" in release:
    raise SystemExit("release-publication-gates: GitHub release must depend on verified Docker promotion only")
for token in (
    "Download verified external evidence",
    "actions/download-artifact@",
    "Package retained external evidence",
    "release-evidence-$VERSION.tar.gz",
    "release-evidence-${{ needs.release-contract.outputs.version }}.tar.gz",
):
    if token not in release:
        raise SystemExit(f"release-publication-gates: GitHub release does not retain evidence: {token}")

preview = publish[android_detect_start:]
for token in ("github.event_name == 'workflow_dispatch'", "inputs.android_preview", "android-developer-preview-"):
    if token not in preview:
        raise SystemExit(f"release-publication-gates: Android preview lacks explicit isolation: {token}")
if "startsWith(github.ref, 'refs/tags/v')" in preview:
    raise SystemExit("release-publication-gates: stable tags must not publish Android artifacts")

required_test_contract = (
    "workflow_call:",
    "release_assurance:",
    "  e2e-tests-proxyauth:",
    "  wasm-rebuild-invariance:",
    "  rust-supply-chain:",
    "  release-assurance:",
    "      - build-check",
    "      - unit-tests",
    "      - integration-tests",
    "      - e2e-tests",
    "      - e2e-tests-proxyauth",
    "      - wasm-rebuild-invariance",
    "      - rust-supply-chain",
)
for token in required_test_contract:
    if token not in tests:
        raise SystemExit(f"release-publication-gates: reusable complete check set lacks: {token}")

tests_header = tests.split("jobs:", 1)[0]
if "permissions:" not in tests_header or "contents: read" not in tests_header:
    raise SystemExit("release-publication-gates: test workflow default permissions must be read-only")

build_check_start = tests.index("  build-check:")
wasm_rebuild_start = tests.index("  wasm-rebuild-invariance:", build_check_start)
build_check = tests[build_check_start:wasm_rebuild_start]
for token in (
    "Restore locked .NET solution",
    "dotnet restore Mosaic.slnx --locked-mode",
    "NuGet vulnerability gate",
    "dotnet list Mosaic.slnx package --vulnerable --include-transitive --format json --output-version 1 --no-restore",
    "node.get(\"vulnerabilities\")",
    "raise SystemExit(1)",
):
    if token not in build_check:
        raise SystemExit(f"release-publication-gates: fail-closed NuGet vulnerability gate lacks: {token}")

integration_start = tests.index("  integration-tests:\n")
e2e_start = tests.index("\n  e2e-tests:\n", integration_start)
backend_assurance = tests[integration_start:e2e_start]
for token in (
    "Full backend test suite",
    "dotnet restore apps/backend/Mosaic.Backend.Tests/Mosaic.Backend.Tests.csproj --locked-mode",
    "dotnet test apps/backend/Mosaic.Backend.Tests/Mosaic.Backend.Tests.csproj --no-restore --configuration Release",
):
    if token not in backend_assurance:
        raise SystemExit(f"release-publication-gates: release assurance lacks full backend coverage: {token}")
if re.search(r"dotnet test[^\n]*--filter", backend_assurance):
    raise SystemExit("release-publication-gates: release assurance must not filter the backend test suite")

remote_use = re.compile(r"^\s*-?\s*uses:\s*([^\s@]+/[^\s@]+)@([^\s#]+)", re.MULTILINE)
for workflow_name, workflow in (("publish.yml", publish), ("tests.yml", tests)):
    for action, ref in remote_use.findall(workflow):
        if action.startswith("./"):
            continue
        if not re.fullmatch(r"[0-9a-fA-F]{40}", ref):
            raise SystemExit(
                f"release-publication-gates: {workflow_name} action is not immutable: {action}@{ref}"
            )

print("release-publication-gates: static contract OK")
PY

python3 tests/architecture/test_release_readiness.py
echo "release-publication-gates: OK (source-bound verified evidence, complete assurance, signed digests, retained evidence, and clean consumption)"
