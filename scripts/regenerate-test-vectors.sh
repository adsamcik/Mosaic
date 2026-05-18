#!/usr/bin/env bash
# Thin wrapper around scripts/regenerate-test-vectors.mjs for Linux/macOS.
# See the .mjs file for full documentation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/regenerate-test-vectors.mjs" "$@"
