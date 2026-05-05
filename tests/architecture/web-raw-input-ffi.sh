#!/usr/bin/env bash
# Web raw-input WASM FFI consumer-side architecture guard.
#
# `no-raw-secret-ffi-export` is the primary producer-side defense: production
# Rust/WASM must not export raw-secret-shaped APIs. This guard is the
# consumer-side defense-in-depth layer. It prevents web TypeScript from
# importing or calling known raw-input bridge names from the WASM package or
# generated wasm-bindgen module if a future test/vector-only bridge is added.
#
# Allowlist policy: only cross-client vector/spec test drivers may consume
# raw-input bridges. Production files in apps/web/src/ are never allowlisted;
# src-local test files are excluded from the production scan, mirroring the
# Kotlin guard's src/main-only semantics.
#
# Allowlist audit checkpoint:
# Last full audit: R-C5.5 at 2d17c47
# Each allowlist entry below MUST carry an explicit classifier prefix and a
# SPECIFIC cryptographic safety argument as its rationale comment. "Reviewed existing API" / "Internal
# use" / "Not a secret" are NOT acceptable rationales. Audits should be
# repeated whenever an entry is added; v1 freeze checkpoint should re-run
# this audit.
# R-C5.5.1 mechanical enforcement: rationales missing a classifier, shorter than 40 chars, or
# matching banned phrases ('reviewed existing api', 'internal use', etc.)
# fail at script execution time. See R-C5.5 audit checkpoint above.
# Classifier vocabulary is locked by SPEC-FfiSecretClassifiers.md (v1).
# Permitted classifiers: SAFE, BEARER-TOKEN-PERMITTED, CORPUS-DRIVER-ONLY,
# MIGRATION-PENDING. Adding a new classifier requires a SPEC amendment.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

python3 - <<'PY'
import re
from pathlib import Path

forbidden_names = [
    "verifyAndOpenBundle",
    "sealAndSignBundle",
    "importEpochKeyHandleFromBundle",
    "getTierKeyFromEpoch",
    "deriveContentKeyFromEpoch",
    "wrapKey",
    "unwrapKey",
    "deriveDbSessionKeyFromAccount",
    "generateLinkSecret",
    "deriveLinkKeys",
    "wrapTierKeyForLink",
    "unwrapTierKeyFromLink",
    "verify_and_open_bundle",
    "seal_and_sign_bundle",
    "seal_and_sign_bundle_js",
    "import_epoch_key_handle_from_bundle",
    "import_epoch_key_handle_from_bundle_js",
]

future_raw_bridge_name_pattern = re.compile(r"\b[A-Za-z_$][A-Za-z0-9_$]*(RawSecret|ForVectors)[A-Za-z0-9_$]*\b")
import_pattern = re.compile(r"import\s+(?:type\s+)?(?P<clause>.*?)\s+from\s+['\"](?P<module>[^'\"]+)['\"]", re.DOTALL)
target_module_pattern = re.compile(r"^(?:@mosaic/wasm|mosaic-wasm)$|(?:^|/)generated/mosaic-wasm/mosaic_wasm(?:\.js)?$")
namespace_import_pattern = re.compile(r"\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\b")

allowlisted_files = {
    # Test-only cross-client vector driver is excluded from production src; it exercises raw-input bridges against public corpora.
    "apps/web/tests/cross-client-vectors.test.ts": "SAFE: Test-only cross-client vector driver is excluded from production src; it exercises raw-input bridges against public corpora.",
}

banned_rationale_phrases = [
    "reviewed existing api",
    "internal use",
    "not a secret",
    "todo",
    "trust me",
    "fixme",
    "tbd",
]
min_rationale_length = 40
rationale_fix_suggestion = "Replace with a sentence stating the SPECIFIC bytes returned and why an attacker gains no advantage."
permitted_classifiers = {"SAFE", "BEARER-TOKEN-PERMITTED", "CORPUS-DRIVER-ONLY", "MIGRATION-PENDING"}
classifier_pattern = re.compile(r"^([A-Z][A-Z0-9-]+):")

def get_allowlist_rationale_errors(*allowlist_tables):
    rationale_errors = []
    for table in allowlist_tables:
        for name, rationale_value in table.items():
            rationale = (rationale_value or "").strip()
            if len(rationale) < min_rationale_length:
                rationale_errors.append(f"Allowlist entry '{name}' failed length check: \"{rationale}\" ({rationale_fix_suggestion})")
            lowered = rationale.lower()
            for phrase in banned_rationale_phrases:
                if phrase in lowered:
                    rationale_errors.append(f"Allowlist entry '{name}' failed banned phrase check ('{phrase}'): \"{rationale}\" ({rationale_fix_suggestion})")
            classifier_match = classifier_pattern.match(rationale)
            if classifier_match:
                if classifier_match.group(1) not in permitted_classifiers:
                    rationale_errors.append(
                        f"Allowlist entry '{name}' failed classifier check ('{classifier_match.group(1)}'): "
                        "classifier vocabulary is locked by SPEC-FfiSecretClassifiers.md"
                    )
            else:
                rationale_errors.append(
                    f"Allowlist entry '{name}' failed missing classifier check: "
                    "rationale must start with one of the permitted classifiers followed by ':'"
                )
    return rationale_errors

def assert_rationale_quality_fixture_caught(name, rationale, expected_check):
    fixture_errors = get_allowlist_rationale_errors({f"tests/architecture/negative-fixtures/{name}": rationale})
    if not any(expected_check in error for error in fixture_errors):
        raise AssertionError(
            f"rationale negative fixture {name!r} did not catch expected check {expected_check!r}. "
            f"Errors: {fixture_errors!r}"
        )

def invoke_allowlist_rationale_quality_check(*allowlist_tables):
    rationale_errors = get_allowlist_rationale_errors(*allowlist_tables)
    if rationale_errors:
        print("Allowlist rationale quality check FAILED:")
        for rationale_error in rationale_errors:
            print(f"  {rationale_error}")
        print()
        print("Each rationale MUST state the SPECIFIC bytes returned and why an attacker gains no advantage.")
        print("See R-C5.5 audit checkpoint comment block for the standard.")
        raise SystemExit(1)

def is_production_source(repo_path: str) -> bool:
    if not repo_path.startswith("apps/web/src/"):
        return False
    if repo_path.startswith("apps/web/src/generated/"):
        return False
    if "/__tests__/" in repo_path:
        return False
    if re.search(r"\.(test|spec)\.tsx?$", repo_path):
        return False
    return True

def iter_web_typescript_files():
    for root in (Path("apps/web/src"), Path("apps/web/tests")):
        if not root.exists():
            continue
        for pattern in ("*.ts", "*.tsx"):
            yield from root.rglob(pattern)

assert_rationale_quality_fixture_caught("rationale-reviewed-existing-api", "reviewed existing api", "banned phrase check")
assert_rationale_quality_fixture_caught("rationale-internal-use", "internal use", "banned phrase check")
assert_rationale_quality_fixture_caught("rationale-not-a-secret", "not a secret", "banned phrase check")
assert_rationale_quality_fixture_caught("rationale-todo", "todo", "banned phrase check")
assert_rationale_quality_fixture_caught("rationale-trust-me", "trust me", "banned phrase check")
assert_rationale_quality_fixture_caught("rationale-fixme", "fixme", "banned phrase check")
assert_rationale_quality_fixture_caught("rationale-tbd", "tbd", "banned phrase check")
assert_rationale_quality_fixture_caught("rationale-short", "short", "length check")
assert_rationale_quality_fixture_caught(
    "rationale-missing-classifier",
    "Returns placeholder bytes with a long enough rationale for classifier validation.",
    "missing classifier check",
)
assert_rationale_quality_fixture_caught(
    "rationale-unknown-classifier",
    "BACKWARD-COMPAT-LEGACY: Returns placeholder bytes with a long enough rationale for classifier validation.",
    "classifier check",
)
invoke_allowlist_rationale_quality_check(allowlisted_files)

violations = []
for path in iter_web_typescript_files():
    repo_path = path.as_posix()
    if repo_path in allowlisted_files:
        continue
    if not is_production_source(repo_path) and not repo_path.startswith("apps/web/tests/"):
        continue

    contents = path.read_text(encoding="utf-8")
    for match in import_pattern.finditer(contents):
        module = match.group("module")
        if not target_module_pattern.search(module):
            continue

        clause = match.group("clause")
        for name in forbidden_names:
            if re.search(rf"\b{re.escape(name)}\b", clause):
                violations.append(f"{repo_path}: forbidden raw-input WASM import '{name}' from '{module}'")

        for future_name in sorted({m.group(0) for m in future_raw_bridge_name_pattern.finditer(clause)}):
            violations.append(f"{repo_path}: forbidden future raw-input WASM import '{future_name}' from '{module}'")

        namespace_match = namespace_import_pattern.search(clause)
        if namespace_match:
            alias = namespace_match.group(1)
            for name in forbidden_names:
                if re.search(rf"\b{re.escape(alias)}\.{re.escape(name)}\b", contents):
                    violations.append(f"{repo_path}: forbidden raw-input WASM namespace usage '{alias}.{name}' from '{module}'")
            future_namespace_pattern = re.compile(rf"\b{re.escape(alias)}\.({future_raw_bridge_name_pattern.pattern})")
            for future_name in sorted({m.group(1) for m in future_namespace_pattern.finditer(contents)}):
                violations.append(f"{repo_path}: forbidden future raw-input WASM namespace usage '{alias}.{future_name}' from '{module}'")

if violations:
    print("\nweb-raw-input-ffi guard FAILED:")
    for violation in sorted(set(violations)):
        print(f"  {violation}")
    print("\nRaw-secret-shaped WASM bridges are test/vector-only; production web code must use handle-based APIs.")
    raise SystemExit(1)

print("web-raw-input-ffi guard: OK (no production callers of raw-input WASM bridges)")
PY
