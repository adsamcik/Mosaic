#!/usr/bin/env bash
set -euo pipefail

SKIP_SUPPLY_CHAIN=false
if [[ "${1:-}" == "--skip-supply-chain" ]]; then
  SKIP_SUPPLY_CHAIN=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

run_step() {
  local name="$1"
  shift
  echo
  echo "==> $name"
  "$@"
}

require_tool() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required. Install it with: cargo install $command_name --locked" >&2
    exit 1
  fi
}

run_step "Rust format" cargo fmt --all --check
run_step "Rust clippy" cargo clippy --workspace --all-targets --all-features -- -D warnings
run_step "Rust tests" cargo test --workspace --locked
run_step "Rust architecture boundaries" bash "$PROJECT_ROOT/tests/architecture/rust-boundaries.sh"
run_step "Rust cutover boundary" pwsh "$PROJECT_ROOT/tests/architecture/rust-cutover-boundary.ps1"

if [[ "$SKIP_SUPPLY_CHAIN" == "false" ]]; then
  require_tool cargo-deny
  require_tool cargo-audit
  require_tool cargo-vet
  run_step "Rust dependency policy" cargo deny check
  run_step "Rust advisory audit" cargo audit
  run_step "Rust cargo-vet policy" cargo vet
fi
