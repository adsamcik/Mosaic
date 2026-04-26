#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

rustup target add wasm32-unknown-unknown
cargo build -p mosaic-wasm --target wasm32-unknown-unknown --release --locked

if command -v wasm-bindgen >/dev/null 2>&1; then
  out_dir="$PROJECT_ROOT/target/wasm-bindgen/mosaic-wasm"
  mkdir -p "$out_dir"
  wasm-bindgen \
    --target web \
    --out-dir "$out_dir" \
    "$PROJECT_ROOT/target/wasm32-unknown-unknown/release/mosaic_wasm.wasm"
else
  echo "wasm-bindgen is not installed; generated JS bindings were skipped." >&2
fi
