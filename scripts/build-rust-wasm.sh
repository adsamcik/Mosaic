#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WASM_BINDGEN_VERSION="0.2.118"
cd "$PROJECT_ROOT"

if ! rustup target list --installed | grep -qx "wasm32-unknown-unknown"; then
  rustup target add wasm32-unknown-unknown
fi

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "wasm-bindgen CLI is required. Install it with: cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked" >&2
  exit 1
fi

actual_version="$(wasm-bindgen --version | awk '{print $2}')"
if [[ "$actual_version" != "$WASM_BINDGEN_VERSION" ]]; then
  echo "wasm-bindgen CLI version mismatch: expected ${WASM_BINDGEN_VERSION}, got ${actual_version}" >&2
  exit 1
fi

cargo_features=()
if [[ -n "${MOSAIC_WASM_CARGO_FEATURES:-}" ]]; then
  cargo_features=(--features "$MOSAIC_WASM_CARGO_FEATURES")
fi

# Deterministic WASM artifacts across hosts (Windows MSVC vs Linux):
#   * --remap-path-prefix collapses absolute build paths (CWD + cargo registry +
#     rustup sysroot) into stable relative tokens so embedded path strings do
#     not leak the host filesystem layout.
#   * `lto = "fat"` in [profile.release] is set workspace-wide; combined with
#     codegen-units=1 it yields a single deterministic LTO pass.
# Result: byte-identical apps/web/src/generated/mosaic-wasm/*.wasm on Windows
# and Linux runners. Verified by the wasm-rebuild-invariance CI job.
rustup_home="$(rustup show home 2>/dev/null || echo "${RUSTUP_HOME:-${HOME:-}}/.rustup")"
cargo_home="${CARGO_HOME:-${HOME:-}/.cargo}"
remap=(
  "--remap-path-prefix=${PROJECT_ROOT}=mosaic"
  "--remap-path-prefix=${cargo_home}=cargo-home"
  "--remap-path-prefix=${rustup_home}=rustup-home"
)
RUSTFLAGS="${RUSTFLAGS:-} ${remap[*]}" \
  cargo build -p mosaic-wasm --target wasm32-unknown-unknown --release --locked "${cargo_features[@]}"

out_dir="$PROJECT_ROOT/target/wasm-bindgen/mosaic-wasm"
mkdir -p "$out_dir"
wasm-bindgen \
  --target web \
  --out-dir "$out_dir" \
  "$PROJECT_ROOT/target/wasm32-unknown-unknown/release/mosaic_wasm.wasm"

web_out_dir="$PROJECT_ROOT/apps/web/src/generated/mosaic-wasm"
mkdir -p "$web_out_dir"
cp "$out_dir/mosaic_wasm.js" "$web_out_dir/"
cp "$out_dir/mosaic_wasm.d.ts" "$web_out_dir/"
cp "$out_dir/mosaic_wasm_bg.wasm" "$web_out_dir/"
cp "$out_dir/mosaic_wasm_bg.wasm.d.ts" "$web_out_dir/"
