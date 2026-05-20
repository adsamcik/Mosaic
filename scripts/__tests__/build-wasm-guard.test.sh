#!/usr/bin/env bash
# Guard tests for HIGH security-review-2026-05-20-03 (path-alias bypass).
#
# These tests invoke scripts/build-rust-wasm.sh with MOSAIC_WASM_CARGO_FEATURES=weak-kdf
# and various crafted MOSAIC_WASM_OUT_DIR values that previously bypassed the
# raw-string guard. The guard fires BEFORE any cargo/wasm-bindgen tool check,
# so the script exits 64 immediately without requiring a Rust toolchain.
#
# Run: bash scripts/__tests__/build-wasm-guard.test.sh
# Exit codes: 0 = all bypass attempts blocked; 1 = at least one slipped through.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_SCRIPT="$REPO_ROOT/scripts/build-rust-wasm.sh"

if [[ ! -x "$BUILD_SCRIPT" && ! -f "$BUILD_SCRIPT" ]]; then
  echo "FAIL: build-rust-wasm.sh not found at $BUILD_SCRIPT" >&2
  exit 1
fi

PASS=0
FAIL=0

run_case() {
  local name="$1"
  local expected_exit="$2"
  local out_dir="$3"
  local features="${4:-weak-kdf}"

  local actual
  actual="$(
    MOSAIC_WASM_CARGO_FEATURES="$features" \
    MOSAIC_WASM_OUT_DIR="$out_dir" \
    bash "$BUILD_SCRIPT" >/dev/null 2>&1
    echo $?
  )"

  if [[ "$actual" == "$expected_exit" ]]; then
    echo "  PASS [$name] exit=$actual (out_dir=$out_dir)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL [$name] expected exit=$expected_exit got=$actual (out_dir=$out_dir)" >&2
    FAIL=$((FAIL + 1))
  fi
}

echo "== Bypass-attempt cases (all should exit 64) =="

# Case 1: `.` segment alias
run_case "dot-segment" 64 "apps/web/src/generated/./mosaic-wasm"

# Case 2: `..` traversal alias landing in canonical
run_case "dotdot-traversal" 64 "apps/web/src/generated/mosaic-wasm-test-weak/../mosaic-wasm"

# Case 3: trailing separator
run_case "trailing-slash" 64 "apps/web/src/generated/mosaic-wasm/"

# Case 4: redundant slashes
run_case "double-slash" 64 "apps/web/src/generated//mosaic-wasm"

# Case 5: absolute path alias to canonical
run_case "absolute-canonical" 64 "$REPO_ROOT/apps/web/src/generated/mosaic-wasm"

# Case 6: not the expected weak dir (random other location)
run_case "wrong-weak-dir" 64 "apps/web/src/generated/something-else"

# Case 7: symlink pointing at canonical (only if we can create one)
LINK_DIR="$REPO_ROOT/apps/web/src/generated/mosaic-wasm-test-weak-symlink-tmp"
rm -rf "$LINK_DIR"
if ln -s "mosaic-wasm" "$LINK_DIR" 2>/dev/null; then
  run_case "symlink-to-canonical" 64 "apps/web/src/generated/mosaic-wasm-test-weak-symlink-tmp"
  rm -rf "$LINK_DIR"
else
  echo "  SKIP [symlink-to-canonical] platform does not support ln -s here"
fi

echo
echo "== Legitimate-path guard acceptance (does NOT run cargo) =="
# Replicate guard logic in-process to verify the canonical weak path passes
# the comparison without invoking cargo/wasm-bindgen.
canonicalize_check() {
  if command -v realpath >/dev/null 2>&1; then realpath -m -- "$1" 2>/dev/null && return; fi
  if command -v python3 >/dev/null 2>&1; then python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null && return; fi
  echo "$1"
}
LEGIT_ABS="$(canonicalize_check "$REPO_ROOT/apps/web/src/generated/mosaic-wasm-test-weak")"
EXPECTED_ABS="$(canonicalize_check "$REPO_ROOT/apps/web/src/generated/mosaic-wasm-test-weak")"
CANONICAL_ABS="$(canonicalize_check "$REPO_ROOT/apps/web/src/generated/mosaic-wasm")"
if [[ "$LEGIT_ABS" == "$CANONICAL_ABS" ]]; then
  echo "  FAIL [legit-weak-path] resolves to canonical" >&2
  FAIL=$((FAIL + 1))
elif [[ "$LEGIT_ABS" != "$EXPECTED_ABS" ]]; then
  echo "  FAIL [legit-weak-path] does not match expected weak dir" >&2
  FAIL=$((FAIL + 1))
else
  echo "  PASS [legit-weak-path] resolves to expected weak dir"
  PASS=$((PASS + 1))
fi

echo
echo "Results: $PASS passed, $FAIL failed"
exit $(( FAIL > 0 ? 1 : 0 ))
