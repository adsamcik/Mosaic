#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

python3 - <<'PY'
import re
from pathlib import Path

ffi_files = [Path("crates/mosaic-wasm/src/lib.rs"), Path("crates/mosaic-uniffi/src/lib.rs")]
dts_files = [Path("apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts")]
secret_result_types = re.compile(r"->\s*(Vec\s*<\s*u8\s*>|BytesResult|JsBytesResult|LinkKeysResult|JsLinkKeysResult|OpenedBundleResult|JsOpenedBundleResult|LinkKeysFfiResult|OpenedBundleFfiResult)")
secret_name_pattern = re.compile(r"(derive.*(key|keys|secret)|get.*key|unwrap.*key|unwrap.*tier.*key|verify_and_open_bundle)", re.IGNORECASE)
secret_shaped_name = re.compile(r"(seed|secret|key)$", re.IGNORECASE)
public_key_name = re.compile(r"(public_?key|pub_?key|PublicKey|PubKey|pubkey)", re.IGNORECASE)
allowlist = {
    "crates/mosaic-wasm/src/lib.rs::derive_link_keys",
    "crates/mosaic-wasm/src/lib.rs::derive_link_keys_js",
    "crates/mosaic-wasm/src/lib.rs::unwrap_key",
    "crates/mosaic-wasm/src/lib.rs::unwrap_key_js",
    "crates/mosaic-wasm/src/lib.rs::unwrap_tier_key_from_link",
    "crates/mosaic-wasm/src/lib.rs::unwrap_tier_key_from_link_js",
    "crates/mosaic-wasm/src/lib.rs::derive_db_session_key_from_account",
    "crates/mosaic-wasm/src/lib.rs::derive_db_session_key_from_account_js",
    "crates/mosaic-uniffi/src/lib.rs::derive_link_keys_from_raw_secret",
    "crates/mosaic-uniffi/src/lib.rs::verify_and_open_bundle_with_recipient_seed",
}
struct_field_allowlist = {
    "crates/mosaic-wasm/src/lib.rs::AccountUnlockRequest.wrapped_account_key",
    "crates/mosaic-wasm/src/lib.rs::CreateAccountResult.wrapped_account_key",
    "crates/mosaic-wasm/src/lib.rs::IdentityHandleResult.wrapped_seed",
    "crates/mosaic-wasm/src/lib.rs::EpochKeyHandleResult.wrapped_epoch_seed",
    "crates/mosaic-wasm/src/lib.rs::LinkKeysResult.wrapping_key",
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
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::LinkKeysResult.wrappingKey",
    "apps/web/src/generated/mosaic-wasm/mosaic_wasm.d.ts::WrappedTierKeyResult.encryptedKey",
}

def is_secret_name(name: str) -> bool:
    return bool(secret_shaped_name.search(name)) and not public_key_name.search(name)

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

        match = re.match(r"\s*pub\s+fn\s+([A-Za-z0-9_]+)", line)
        if not match:
            continue
        name = match.group(1)
        if public_key_name.search(name):
            continue
        signature = line
        cursor = index
        while "{" not in signature and cursor + 1 < len(lines):
            cursor += 1
            signature += " " + lines[cursor].strip()
        key = f"{path.as_posix()}::{name}"
        if secret_name_pattern.search(name) and secret_result_types.search(signature) and key not in allowlist:
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
