#!/usr/bin/env bash
set -euo pipefail

CARGO_NDK_VERSION="4.1.2"
UNIFFI_VERSION="0.31.1"
DEFAULT_ABIS=("arm64-v8a" "x86_64")
VALID_ABIS=("arm64-v8a" "armeabi-v7a" "x86" "x86_64")
readonly CARGO_NDK_VERSION UNIFFI_VERSION DEFAULT_ABIS VALID_ABIS

if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "cargo-ndk is required for Android Rust builds. Install it with: cargo install cargo-ndk --version ${CARGO_NDK_VERSION} --locked" >&2
  exit 1
fi

cargo_ndk_version="$(cargo ndk --version | awk '{print $2}')"
if [[ "$cargo_ndk_version" != "$CARGO_NDK_VERSION" ]]; then
  echo "cargo-ndk version mismatch: expected ${CARGO_NDK_VERSION}, got ${cargo_ndk_version}" >&2
  exit 1
fi

if ! command -v uniffi-bindgen >/dev/null 2>&1; then
  echo "uniffi-bindgen is required for Kotlin bindings. Install it with: cargo install uniffi --features cli --version ${UNIFFI_VERSION} --locked" >&2
  exit 1
fi

uniffi_version="$(uniffi-bindgen --version | awk '{print $2}')"
if [[ "$uniffi_version" != "$UNIFFI_VERSION" ]]; then
  echo "uniffi-bindgen version mismatch: expected ${UNIFFI_VERSION}, got ${uniffi_version}" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

abis=("$@")
if [[ "${#abis[@]}" -eq 0 ]]; then
  abis=("${DEFAULT_ABIS[@]}")
fi

cargo_ndk_targets=()
rust_feature_args=()
if [[ -n "${MOSAIC_UNIFFI_CARGO_FEATURES:-}" ]]; then
  rust_feature_args+=("--features" "$MOSAIC_UNIFFI_CARGO_FEATURES")
fi

for abi in "${abis[@]}"; do
  valid=false
  for valid_abi in "${VALID_ABIS[@]}"; do
    if [[ "$abi" == "$valid_abi" ]]; then
      valid=true
      break
    fi
  done

  if [[ "$valid" != true ]]; then
    echo "Invalid Android ABI: $abi" >&2
    exit 1
  fi

  cargo_ndk_targets+=("--target" "$abi")
done

cargo ndk \
  "${cargo_ndk_targets[@]}" \
  --output-dir "$PROJECT_ROOT/target/android" \
  build -p mosaic-uniffi --release --locked "${rust_feature_args[@]}"

cargo build -p mosaic-uniffi --release --locked "${rust_feature_args[@]}"

# UniFFI 0.31 can exit successfully without emitting Kotlin when probing the
# Linux cdylib. The rlib contains the same setup_scaffolding! metadata and is
# consistently discoverable by --library mode across host platforms.
host_library_path="$PROJECT_ROOT/target/release/libmosaic_uniffi.rlib"

kotlin_out_dir="$PROJECT_ROOT/target/android/kotlin"
rm -rf "$kotlin_out_dir"
mkdir -p "$kotlin_out_dir"
uniffi-bindgen generate \
  --language kotlin \
  --out-dir "$kotlin_out_dir" \
  --no-format \
  --library \
  --crate mosaic_uniffi \
  "$host_library_path"

if ! find "$kotlin_out_dir" -type f -name '*.kt' | grep -q .; then
  echo "UniFFI Kotlin binding generation produced no .kt files in $kotlin_out_dir" >&2
  exit 1
fi
