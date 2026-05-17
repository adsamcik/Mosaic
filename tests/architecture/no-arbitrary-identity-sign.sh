#!/usr/bin/env bash
set -euo pipefail

# Architecture guard: no-arbitrary-identity-sign (v1.0.1 f14-1).
#
# Background
# ----------
# `sign_manifest_with_identity` in `crates/mosaic-crypto/src/lib.rs` signs a
# caller-supplied byte buffer with the per-account Ed25519 *identity* key.
# Before v1.0.1 f14-1 it signed `transcript_bytes` verbatim, which made the
# FFI exports (`mosaic_wasm::sign_manifest_with_identity`,
# `mosaic_uniffi::sign_manifest_with_identity`) a signing oracle: a caller
# could pass `BUNDLE_SIGN_CONTEXT || <crafted-sealed-box>` and recover a
# valid sealed-bundle signature, completely bypassing the bundle-distribution
# zero-knowledge model.
#
# Fix landed in v1.0.1 f14-1:
#   * `sign_manifest_with_identity` now prepends `MANIFEST_SIGN_CONTEXT`
#     (`b"Mosaic_Manifest_v1"`).
#   * `seal_and_sign_bundle` / `verify_and_open_bundle` bypass the manifest
#     function and sign/verify Ed25519 directly over
#     `BUNDLE_SIGN_CONTEXT || sealed` so the two domains never alias.
#
# This guard prevents future regressions on:
#   1. NEW FFI exports on the boundary crates that match the
#      "sign...identity" name shape but skip the allowlist.
#   2. The MANIFEST_SIGN_CONTEXT constant being silently changed
#      (cross-platform sig compatibility).
#   3. sign_manifest_with_identity dropping the prefix again.
#   4. The bundle path being re-routed through sign_manifest_with_identity,
#      which would re-open the oracle by alias.
#
# The Python implementation lives in
# tests/architecture/no-arbitrary-identity-sign.py so the .sh and .ps1
# wrappers can share it byte-for-byte.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"
exec python3 "$SCRIPT_DIR/no-arbitrary-identity-sign.py"
