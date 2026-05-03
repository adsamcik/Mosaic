#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

python3 - <<'PY'
import re
from pathlib import Path

ffi_files = [Path("crates/mosaic-wasm/src/lib.rs"), Path("crates/mosaic-uniffi/src/lib.rs")]
secret_result_types = re.compile(r"->\s*(Vec\s*<\s*u8\s*>|BytesResult|JsBytesResult|LinkKeysResult|JsLinkKeysResult|OpenedBundleResult|JsOpenedBundleResult|LinkKeysFfiResult|OpenedBundleFfiResult)")
secret_name_pattern = re.compile(r"(derive.*(key|keys|secret)|get.*key|unwrap.*key|unwrap.*tier.*key|verify_and_open_bundle)")
allowlist = {
    "crates/mosaic-wasm/src/lib.rs::get_tier_key_from_epoch",
    "crates/mosaic-wasm/src/lib.rs::get_tier_key_from_epoch_js",
    "crates/mosaic-wasm/src/lib.rs::derive_content_key_from_epoch",
    "crates/mosaic-wasm/src/lib.rs::derive_content_key_from_epoch_js",
    "crates/mosaic-wasm/src/lib.rs::derive_link_keys",
    "crates/mosaic-wasm/src/lib.rs::derive_link_keys_js",
    "crates/mosaic-wasm/src/lib.rs::unwrap_key",
    "crates/mosaic-wasm/src/lib.rs::unwrap_key_js",
    "crates/mosaic-wasm/src/lib.rs::unwrap_tier_key_from_link",
    "crates/mosaic-wasm/src/lib.rs::unwrap_tier_key_from_link_js",
    "crates/mosaic-wasm/src/lib.rs::verify_and_open_bundle",
    "crates/mosaic-wasm/src/lib.rs::verify_and_open_bundle_js",
    "crates/mosaic-wasm/src/lib.rs::derive_db_session_key_from_account",
    "crates/mosaic-wasm/src/lib.rs::derive_db_session_key_from_account_js",
    "crates/mosaic-uniffi/src/lib.rs::derive_link_keys_from_raw_secret",
    "crates/mosaic-uniffi/src/lib.rs::verify_and_open_bundle_with_recipient_seed",
}
violations = []
for path in ffi_files:
    lines = path.read_text(encoding="utf-8").splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"\s*pub\s+fn\s+([A-Za-z0-9_]+)", line)
        if not match:
            continue
        name = match.group(1)
        if "public_key" in name:
            continue
        signature = line
        cursor = index
        while "{" not in signature and cursor + 1 < len(lines):
            cursor += 1
            signature += " " + lines[cursor].strip()
        key = f"{path.as_posix()}::{name}"
        if secret_name_pattern.search(name) and secret_result_types.search(signature) and key not in allowlist:
            violations.append(f"{path.as_posix()}:{index + 1}: forbidden raw-secret-shaped FFI export '{name}' -> {signature.strip()}")
if violations:
    print("\nno-raw-secret-ffi-export guard FAILED:")
    for violation in violations:
        print(f"  {violation}")
    print("\nADR-006/ADR-021 require key access through opaque handles.")
    raise SystemExit(1)
print("no-raw-secret-ffi-export guard: OK (no new raw key-shaped FFI exports)")
PY
