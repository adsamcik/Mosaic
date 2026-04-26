#!/usr/bin/env bash
set -euo pipefail

if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "cargo-ndk is required for Android Rust builds. Install it with: cargo install cargo-ndk --locked" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

cargo ndk \
  --target arm64-v8a \
  --target x86_64 \
  --output-dir "$PROJECT_ROOT/target/android" \
  build -p mosaic-uniffi --release --locked
