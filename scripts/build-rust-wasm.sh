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

cargo build -p mosaic-wasm --target wasm32-unknown-unknown --release --locked

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
