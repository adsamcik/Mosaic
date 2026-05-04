#!/usr/bin/env bash
set -euo pipefail

# Architecture-guard regex maintenance protocol:
# 1. Every regex extension MUST be accompanied by a negative-test fixture
#    proving the new pattern catches what the old missed.
# 2. Fixtures live inline in invoke_negative_fixtures() below and run as part of CI.
# 3. PR adding a new pattern without a fixture should be rejected at review.

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
    "crates/mosaic-wasm/src/lib.rs::wrapped_account_key",
    "crates/mosaic-wasm/src/lib.rs::wrap_with_account_handle",
    "crates/mosaic-wasm/src/lib.rs::unwrap_with_account_handle",
    "crates/mosaic-wasm/src/lib.rs::wrap_with_account_handle_js",
    "crates/mosaic-wasm/src/lib.rs::unwrap_with_account_handle_js",
    "crates/mosaic-wasm/src/lib.rs::wrapped_epoch_seed",
    "crates/mosaic-wasm/src/lib.rs::identity_message",
    "crates/mosaic-wasm/src/lib.rs::identity_signature",
    "crates/mosaic-wasm/src/lib.rs::link_id",
    "crates/mosaic-wasm/src/lib.rs::link_secret_for_url",
    "crates/mosaic-wasm/src/lib.rs::sign_manifest_with_identity",
    "crates/mosaic-wasm/src/lib.rs::sign_manifest_with_epoch_handle",
    "crates/mosaic-wasm/src/lib.rs::sign_auth_challenge_with_account",
    "crates/mosaic-wasm/src/lib.rs::sign_manifest_with_identity_js",
    "crates/mosaic-wasm/src/lib.rs::sign_manifest_with_epoch_handle_js",
    "crates/mosaic-wasm/src/lib.rs::sign_auth_challenge_with_account_js",
    "crates/mosaic-uniffi/src/lib.rs::derive_link_keys_from_raw_secret",
    "crates/mosaic-uniffi/src/lib.rs::verify_and_open_bundle_with_recipient_seed",
    "crates/mosaic-uniffi/src/lib.rs::sign_manifest_with_identity",
}
struct_field_allowlist = {
    "crates/mosaic-wasm/src/lib.rs::AccountUnlockRequest.wrapped_account_key",
    "crates/mosaic-wasm/src/lib.rs::CreateAccountResult.wrapped_account_key",
    "crates/mosaic-wasm/src/lib.rs::IdentityHandleResult.wrapped_seed",
    "crates/mosaic-wasm/src/lib.rs::EpochKeyHandleResult.wrapped_epoch_seed",
    "crates/mosaic-wasm/src/lib.rs::CreateLinkShareHandleResult.encrypted_key",
    "crates/mosaic-wasm/src/lib.rs::WrappedTierKeyResult.encrypted_key",
    "crates/mosaic-uniffi/src/lib.rs::AccountUnlockRequest.wrapped_account_key",
    "crates/mosaic-uniffi/src/lib.rs::IdentityHandleResult.wrapped_seed",
    "crates/mosaic-uniffi/src/lib.rs::EpochKeyHandleResult.wrapped_epoch_seed",
    "crates/mosaic-uniffi/src/lib.rs::LinkKeysFfiResult.wrapping_key",
    "crates/mosaic-uniffi/src/lib.rs::OpenedBundleFfiResult.epoch_seed",
}
dts_allowlist = {
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::CreateAccountResult.wrappedAccountKey",
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::EpochKeyHandleResult.wrappedEpochSeed",
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::IdentityHandleResult.wrappedSeed",
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::CreateLinkShareHandleResult.encryptedKey",
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::WrappedTierKeyResult.encryptedKey",
}

def is_secret_name(name: str) -> bool:
    return bool(secret_shaped_name.search(name)) and not public_key_name.search(name)

def assert_negative_fixture_caught(name: str, source: str, expected_symbol: str) -> None:
    fixture_path = f"tests/architecture/negative-fixtures/{name}.rs"
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
        if (
            not public_key_name.search(function_name)
            and is_secret_shaped_export
            and secret_result_types.search(signature)
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

invoke_negative_fixtures()

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
        if is_secret_shaped_export and secret_result_types.search(signature) and key not in allowlist:
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
