#!/usr/bin/env bash
set -euo pipefail

# Architecture-guard regex maintenance protocol:
# 1. Every regex extension MUST be accompanied by a negative-test fixture
#    proving the new pattern catches what the old missed.
# 2. Fixtures live inline in invoke_negative_fixtures() below and run as part of CI.
# 3. PR adding a new pattern without a fixture should be rejected at review.
# 4. Option B: mosaic-wasm producer exports with exotic byte-array returns
#    (Cow<[u8]>, Box<[u8]>, Uint8Array, ArrayBuffer) are name-agnostic.
#
# Allowlist audit checkpoint:
# Last full audit: R-C5.5 at 2d17c47
# Each allowlist entry below MUST carry a SPECIFIC cryptographic safety
# argument as its rationale comment. "Reviewed existing API" / "Internal
# use" / "Not a secret" are NOT acceptable rationales. Audits should be
# repeated whenever an entry is added; v1 freeze checkpoint should re-run
# this audit.
# R-C5.5.1 mechanical enforcement: rationales shorter than 40 chars or
# matching banned phrases ('reviewed existing api', 'internal use', etc.)
# fail at script execution time. See R-C5.5 audit checkpoint above.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

python3 - <<'PY'
import re
from pathlib import Path

ffi_files = [Path("crates/mosaic-wasm/src/lib.rs"), Path("crates/mosaic-uniffi/src/lib.rs")]
dts_files = [Path("apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts")]
# JsValue is intentionally treated as secret-shaped for wasm exports. It is fuzzy
# because serde_wasm_bindgen can smuggle byte arrays through JsValue; reviewers can
# use the explicit allowlist when a non-secret JsValue API is justified.
secret_result_types = re.compile(r"->\s*(Vec\s*<\s*u8\s*>|Box\s*<\s*\[\s*u8\s*\]\s*>|Cow\s*<[^>]*\[\s*u8\s*\][^>]*>|(?:js_sys\s*::\s*)?Uint8Array|(?:js_sys\s*::\s*)?ArrayBuffer|JsValue|BytesResult|JsBytesResult|LinkKeysResult|JsLinkKeysResult|OpenedBundleResult|JsOpenedBundleResult|LinkKeysFfiResult|OpenedBundleFfiResult)")
exotic_wasm_result_types = re.compile(r"->\s*(Box\s*<\s*\[\s*u8\s*\]\s*>|Cow\s*<[^>]*\[\s*u8\s*\][^>]*>|(?:js_sys\s*::\s*)?Uint8Array|(?:js_sys\s*::\s*)?ArrayBuffer)")
secret_name_pattern = re.compile(r"(derive.*(key|keys|secret)|generate.*secret|get.*key|wrap.*key|unwrap.*key|unwrap.*tier.*key|verify_and_open_bundle)", re.IGNORECASE)
domain_handle_pattern = re.compile(r"(^(wrap|unwrap)_.*(account|epoch|identity|link).*(handle|seed|key|secret)|^(seal|unseal)_.*(account|epoch|identity|link).*handle)", re.IGNORECASE)
generic_bytes_wrap_pattern = re.compile(r"^(wrap|unwrap)(_|$)", re.IGNORECASE)
domain_noun_pattern = re.compile(r"(account|epoch|identity|link)", re.IGNORECASE)
secret_shaped_name = re.compile(r"(seed|secret|key)$", re.IGNORECASE)
public_key_name = re.compile(r"(public_?key|pub_?key|PublicKey|PubKey|pubkey)", re.IGNORECASE)
forbidden_raw_bundle_apis = {
    "seal_and_sign_bundle",
    "seal_and_sign_bundle_js",
    "import_epoch_key_handle_from_bundle",
    "import_epoch_key_handle_from_bundle_js",
}
allowlist = {
    # Returns L2 account key encrypted under password-derived L1; unwrap requires password and account salt.
    "crates/mosaic-wasm/src/lib.rs::wrapped_account_key": "Returns L2 account key encrypted under password-derived L1; unwrap requires password and account salt.",
    # Returns ACCOUNT_DATA_AAD AEAD ciphertext; L2 account key remains inside Rust handle registry.
    "crates/mosaic-wasm/src/lib.rs::wrap_with_account_handle": "Returns ACCOUNT_DATA_AAD AEAD ciphertext; L2 account key remains inside Rust handle registry.",
    # Decrypts only ACCOUNT_DATA_AAD blobs via an open handle; does not expose L2 or seed-domain key material.
    "crates/mosaic-wasm/src/lib.rs::unwrap_with_account_handle": "Decrypts only ACCOUNT_DATA_AAD blobs via an open handle; does not expose L2 or seed-domain key material.",
    # Returns ACCOUNT_DATA_AAD AEAD ciphertext to JS; L2 account key remains inside Rust handle registry.
    "crates/mosaic-wasm/src/lib.rs::wrap_with_account_handle_js": "Returns ACCOUNT_DATA_AAD AEAD ciphertext to JS; L2 account key remains inside Rust handle registry.",
    # Decrypts only ACCOUNT_DATA_AAD blobs via JS handle; does not expose L2 or seed-domain key material.
    "crates/mosaic-wasm/src/lib.rs::unwrap_with_account_handle_js": "Decrypts only ACCOUNT_DATA_AAD blobs via JS handle; does not expose L2 or seed-domain key material.",
    # Returns epoch seed encrypted under the account handle wrap key; plaintext seed requires matching L2.
    "crates/mosaic-wasm/src/lib.rs::wrapped_epoch_seed": "Returns epoch seed encrypted under the account handle wrap key; plaintext seed requires matching L2.",
    # Returns fixed golden-vector message bytes for signature verification; contains no key material.
    "crates/mosaic-wasm/src/lib.rs::identity_message": "Returns fixed golden-vector message bytes for signature verification; contains no key material.",
    # Returns Ed25519 detached signature bytes; verifier gains no private signing key material.
    "crates/mosaic-wasm/src/lib.rs::identity_signature": "Returns Ed25519 detached signature bytes; verifier gains no private signing key material.",
    # Returns public link identifier derived from link secret; cannot recover wrapping key from identifier alone.
    "crates/mosaic-wasm/src/lib.rs::link_id": "Returns public link identifier derived from link secret; cannot recover wrapping key from identifier alone.",
    # MIGRATION-PENDING: see r-c5-5-migrate-link-secret-for-url; returns bearer URL fragment seed bytes.
    "crates/mosaic-wasm/src/lib.rs::link_secret_for_url": "MIGRATION-PENDING: see r-c5-5-migrate-link-secret-for-url; returns bearer URL fragment seed bytes.",
    # Returns a 64-byte Ed25519 manifest signature; identity signing key remains inside Rust handle.
    "crates/mosaic-wasm/src/lib.rs::sign_manifest_with_identity": "Returns a 64-byte Ed25519 manifest signature; identity signing key remains inside Rust handle.",
    # Returns a 64-byte Ed25519 manifest signature; epoch signing seed remains inside Rust handle.
    "crates/mosaic-wasm/src/lib.rs::sign_manifest_with_epoch_handle": "Returns a 64-byte Ed25519 manifest signature; epoch signing seed remains inside Rust handle.",
    # Returns a 64-byte Ed25519 auth signature; account-derived signing secret is not exported.
    "crates/mosaic-wasm/src/lib.rs::sign_auth_challenge_with_account": "Returns a 64-byte Ed25519 auth signature; account-derived signing secret is not exported.",
    # Returns JS-visible Ed25519 manifest signature bytes; identity signing key remains inside Rust handle.
    "crates/mosaic-wasm/src/lib.rs::sign_manifest_with_identity_js": "Returns JS-visible Ed25519 manifest signature bytes; identity signing key remains inside Rust handle.",
    # Returns JS-visible Ed25519 manifest signature bytes; epoch signing seed remains inside Rust handle.
    "crates/mosaic-wasm/src/lib.rs::sign_manifest_with_epoch_handle_js": "Returns JS-visible Ed25519 manifest signature bytes; epoch signing seed remains inside Rust handle.",
    # Returns JS-visible Ed25519 auth signature bytes; account-derived signing secret is not exported.
    "crates/mosaic-wasm/src/lib.rs::sign_auth_challenge_with_account_js": "Returns JS-visible Ed25519 auth signature bytes; account-derived signing secret is not exported.",
    # MIGRATION-PENDING: see r-c5-5-migrate-derive-link-keys-from-raw-secret; returns raw link wrapping key.
    "crates/mosaic-uniffi/src/lib.rs::derive_link_keys_from_raw_secret": "MIGRATION-PENDING: see r-c5-5-migrate-derive-link-keys-from-raw-secret; returns raw link wrapping key.",
    # MIGRATION-PENDING: see r-c5-5-migrate-verify-and-open-bundle-with-recipient-seed; returns raw epoch seed.
    "crates/mosaic-uniffi/src/lib.rs::verify_and_open_bundle_with_recipient_seed": "MIGRATION-PENDING: see r-c5-5-migrate-verify-and-open-bundle-with-recipient-seed; returns raw epoch seed.",
    # Returns a 64-byte Ed25519 manifest signature; identity signing key remains inside Rust handle.
    "crates/mosaic-uniffi/src/lib.rs::sign_manifest_with_identity": "Returns a 64-byte Ed25519 manifest signature; identity signing key remains inside Rust handle.",
}
struct_field_allowlist = {
    # Input is L2 encrypted under password-derived L1; unlock still requires the password-derived wrap key.
    "crates/mosaic-wasm/src/lib.rs::AccountUnlockRequest.wrapped_account_key": "Input is L2 encrypted under password-derived L1; unlock still requires the password-derived wrap key.",
    # Field stores L2 encrypted under password-derived L1; plaintext L2 never crosses FFI.
    "crates/mosaic-wasm/src/lib.rs::CreateAccountResult.wrapped_account_key": "Field stores L2 encrypted under password-derived L1; plaintext L2 never crosses FFI.",
    # Field stores identity seed encrypted by account L2; opening requires matching account handle.
    "crates/mosaic-wasm/src/lib.rs::IdentityHandleResult.wrapped_seed": "Field stores identity seed encrypted by account L2; opening requires matching account handle.",
    # Field stores epoch seed encrypted by account L2; opening requires matching account handle.
    "crates/mosaic-wasm/src/lib.rs::EpochKeyHandleResult.wrapped_epoch_seed": "Field stores epoch seed encrypted by account L2; opening requires matching account handle.",
    # Field is AEAD ciphertext of tier key under link wrapping key; plaintext tier key is not exported.
    "crates/mosaic-wasm/src/lib.rs::CreateLinkShareHandleResult.encrypted_key": "Field is AEAD ciphertext of tier key under link wrapping key; plaintext tier key is not exported.",
    # Field is AEAD ciphertext of tier key under link wrapping key; plaintext tier key is not exported.
    "crates/mosaic-wasm/src/lib.rs::WrappedTierKeyResult.encrypted_key": "Field is AEAD ciphertext of tier key under link wrapping key; plaintext tier key is not exported.",
    # Input is L2 encrypted under password-derived L1; unlock still requires the password-derived wrap key.
    "crates/mosaic-uniffi/src/lib.rs::AccountUnlockRequest.wrapped_account_key": "Input is L2 encrypted under password-derived L1; unlock still requires the password-derived wrap key.",
    # Field stores identity seed encrypted by account L2; opening requires matching account handle.
    "crates/mosaic-uniffi/src/lib.rs::IdentityHandleResult.wrapped_seed": "Field stores identity seed encrypted by account L2; opening requires matching account handle.",
    # Field stores epoch seed encrypted by account L2; opening requires matching account handle.
    "crates/mosaic-uniffi/src/lib.rs::EpochKeyHandleResult.wrapped_epoch_seed": "Field stores epoch seed encrypted by account L2; opening requires matching account handle.",
}
dts_allowlist = {
    # Type exposes L2 encrypted under password-derived L1; plaintext L2 is not typed as JS output.
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::CreateAccountResult.wrappedAccountKey": "Type exposes L2 encrypted under password-derived L1; plaintext L2 is not typed as JS output.",
    # Type exposes epoch seed encrypted by account L2; opening requires matching account handle.
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::EpochKeyHandleResult.wrappedEpochSeed": "Type exposes epoch seed encrypted by account L2; opening requires matching account handle.",
    # Type exposes identity seed encrypted by account L2; opening requires matching account handle.
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::IdentityHandleResult.wrappedSeed": "Type exposes identity seed encrypted by account L2; opening requires matching account handle.",
    # Type exposes AEAD tier-key ciphertext under link wrapping key; plaintext tier key is absent.
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::CreateLinkShareHandleResult.encryptedKey": "Type exposes AEAD tier-key ciphertext under link wrapping key; plaintext tier key is absent.",
    # Type exposes AEAD tier-key ciphertext under link wrapping key; plaintext tier key is absent.
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::WrappedTierKeyResult.encryptedKey": "Type exposes AEAD tier-key ciphertext under link wrapping key; plaintext tier key is absent.",
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

def is_secret_name(name: str) -> bool:
    return bool(secret_shaped_name.search(name)) and not public_key_name.search(name)

def assert_negative_fixture_caught(
    name: str,
    source: str,
    expected_symbol: str,
    source_path = None,
) -> None:
    fixture_path = source_path or f"tests/architecture/negative-fixtures/{name}.rs"
    fixture_violations = []
    lines = source.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"\s*pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)", line)
        if not match:
            continue
        function_name = match.group(1)
        signature = line
        cursor = index
        while "{" not in signature and cursor + 1 < len(lines):
            cursor += 1
            signature += " " + lines[cursor].strip()
        is_secret_shaped_export = (
            secret_name_pattern.search(function_name)
            or domain_handle_pattern.search(function_name)
            or (
                generic_bytes_wrap_pattern.search(function_name)
                and re.search(r"->\s*(BytesResult|JsBytesResult)", signature)
            )
            or domain_noun_pattern.search(function_name)
        )
        is_name_agnostic_wasm_exotic = (
            fixture_path == "crates/mosaic-wasm/src/lib.rs"
            and exotic_wasm_result_types.search(signature)
        )
        if (
            not public_key_name.search(function_name)
            and (
                (is_secret_shaped_export and secret_result_types.search(signature))
                or is_name_agnostic_wasm_exotic
            )
        ):
            fixture_violations.append(
                f"{fixture_path}:{index + 1}: forbidden raw-secret-shaped FFI export '{function_name}' -> {signature.strip()}"
            )
    if not any(expected_symbol in violation for violation in fixture_violations):
        raise AssertionError(
            f"negative fixture {name!r} did not catch expected symbol {expected_symbol!r}. "
            f"Violations: {fixture_violations!r}"
        )

def invoke_negative_fixtures() -> None:
    assert_negative_fixture_caught(
        "cousin-verb-export-account-seed",
        "pub fn export_account_seed() -> BytesResult { unimplemented!() }",
        "export_account_seed",
    )
    assert_negative_fixture_caught(
        "exotic-return-box-u8",
        "pub fn get_epoch_key() -> Box<[u8]> { unimplemented!() }",
        "get_epoch_key",
    )
    assert_negative_fixture_caught(
        "exotic-return-cow-u8",
        "pub fn get_identity_key() -> Cow<'static, [u8]> { unimplemented!() }",
        "get_identity_key",
    )
    assert_negative_fixture_caught(
        "exotic-return-uint8array",
        "pub fn get_link_key() -> js_sys::Uint8Array { unimplemented!() }",
        "get_link_key",
    )
    assert_negative_fixture_caught(
        "exotic-return-arraybuffer",
        "pub fn get_account_key() -> js_sys::ArrayBuffer { unimplemented!() }",
        "get_account_key",
    )
    assert_negative_fixture_caught(
        "exotic-return-jsvalue",
        "pub fn get_identity_key() -> JsValue { unimplemented!() }",
        "get_identity_key",
    )
    assert_negative_fixture_caught(
        "wasm-bare-name-cow-u8",
        "pub fn leak() -> Cow<'static, [u8]> { unimplemented!() }",
        "leak",
        "crates/mosaic-wasm/src/lib.rs",
    )
    assert_rationale_quality_fixture_caught("rationale-reviewed-existing-api", "reviewed existing api", "banned phrase check")
    assert_rationale_quality_fixture_caught("rationale-internal-use", "internal use", "banned phrase check")
    assert_rationale_quality_fixture_caught("rationale-not-a-secret", "not a secret", "banned phrase check")
    assert_rationale_quality_fixture_caught("rationale-todo", "todo", "banned phrase check")
    assert_rationale_quality_fixture_caught("rationale-trust-me", "trust me", "banned phrase check")
    assert_rationale_quality_fixture_caught("rationale-fixme", "fixme", "banned phrase check")
    assert_rationale_quality_fixture_caught("rationale-tbd", "tbd", "banned phrase check")
    assert_rationale_quality_fixture_caught("rationale-short", "short", "length check")

invoke_negative_fixtures()
invoke_allowlist_rationale_quality_check(allowlist, struct_field_allowlist, dts_allowlist)

violations = []
for path in ffi_files:
    lines = path.read_text(encoding="utf-8").splitlines()
    current_struct = None
    for index, line in enumerate(lines):
        struct_match = re.match(r"\s*pub\s+struct\s+([A-Za-z0-9_]+)", line)
        if struct_match:
            current_struct = struct_match.group(1)
        elif current_struct and re.match(r"\s*}", line):
            current_struct = None
        elif current_struct:
            field_match = re.match(r"\s*pub\s+([A-Za-z0-9_]+)\s*:\s*Vec\s*<\s*u8\s*>", line)
            if field_match:
                field = field_match.group(1)
                key = f"{path.as_posix()}::{current_struct}.{field}"
                if is_secret_name(field) and key not in struct_field_allowlist:
                    violations.append(f"{path.as_posix()}:{index + 1}: forbidden secret-shaped Vec<u8> FFI field '{current_struct}.{field}'")

        match = re.match(r"\s*pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)", line)
        if not match:
            continue
        name = match.group(1)
        if name in forbidden_raw_bundle_apis:
            violations.append(f"{path.as_posix()}:{index + 1}: forbidden raw bundle-secret FFI export '{name}'")
        if public_key_name.search(name):
            continue
        signature = line
        cursor = index
        while "{" not in signature and cursor + 1 < len(lines):
            cursor += 1
            signature += " " + lines[cursor].strip()
        key = f"{path.as_posix()}::{name}"
        is_secret_shaped_export = (
            secret_name_pattern.search(name)
            or domain_handle_pattern.search(name)
            or (
                generic_bytes_wrap_pattern.search(name)
                and re.search(r"->\s*(BytesResult|JsBytesResult)", signature)
            )
            or domain_noun_pattern.search(name)
        )
        is_name_agnostic_wasm_exotic = (
            path.as_posix() == "crates/mosaic-wasm/src/lib.rs"
            and exotic_wasm_result_types.search(signature)
        )
        if (
            (is_secret_shaped_export and secret_result_types.search(signature))
            or is_name_agnostic_wasm_exotic
        ) and key not in allowlist:
            violations.append(f"{path.as_posix()}:{index + 1}: forbidden raw-secret-shaped FFI export '{name}' -> {signature.strip()}")

for path in dts_files:
    if not path.exists():
        continue
    current_class = None
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
        class_match = re.match(r"\s*export\s+class\s+([A-Za-z0-9_]+)", line)
        if class_match:
            current_class = class_match.group(1)
            continue
        if current_class and re.match(r"\s*}", line):
            current_class = None
            continue
        prop_match = re.match(r"\s*readonly\s+([A-Za-z0-9_]+)\s*:\s*Uint8Array", line)
        if current_class and prop_match:
            prop = prop_match.group(1)
            key = f"{path.as_posix()}::{current_class}.{prop}"
            if is_secret_name(prop) and key not in dts_allowlist:
                violations.append(f"{path.as_posix()}:{index + 1}: forbidden secret-shaped Uint8Array WASM property '{current_class}.{prop}'")
        fn_match = re.match(r"\s*export\s+function\s+([A-Za-z0-9_]+)\([^)]*\)\s*:\s*Uint8Array", line)
        if fn_match:
            fn = fn_match.group(1)
            if is_secret_name(fn):
                violations.append(f"{path.as_posix()}:{index + 1}: forbidden secret-shaped Uint8Array WASM function return '{fn}'")

if violations:
    print("\nno-raw-secret-ffi-export guard FAILED:")
    for violation in violations:
        print(f"  {violation}")
    print("\nADR-006/ADR-021 require key access through opaque handles.")
    raise SystemExit(1)
print("no-raw-secret-ffi-export guard: OK (no new raw key-shaped FFI exports)")
PY
