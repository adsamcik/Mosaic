#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WASM_BINDGEN_VERSION="0.2.118"
cd "$PROJECT_ROOT"

# Security guard (HIGH security-review-2026-05-20-02): the `weak-kdf` cargo
# feature relaxes Argon2id to a test-only profile (8 MiB / 1 iter). Bytes
# built with it MUST NOT land at the canonical production output path
# (apps/web/src/generated/mosaic-wasm) — otherwise a production bundle could
# silently inherit the relaxed KDF floor. Hard-fail BEFORE any toolchain
# work so misconfigured callers see a crisp error instead of toolchain noise.
CANONICAL_OUT_DIR="apps/web/src/generated/mosaic-wasm"
EXPECTED_WEAK_OUT_DIR="apps/web/src/generated/mosaic-wasm-test-weak"
if [[ ",${MOSAIC_WASM_CARGO_FEATURES:-}," == *",weak-kdf,"* ]]; then
  effective_out_dir="${MOSAIC_WASM_OUT_DIR:-${CANONICAL_OUT_DIR}}"
  if [[ "${effective_out_dir}" == "${CANONICAL_OUT_DIR}" ]]; then
    echo "❌ ERROR: weak-kdf feature requires MOSAIC_WASM_OUT_DIR=${EXPECTED_WEAK_OUT_DIR}" >&2
    echo "   Writing weak-kdf bytes into the canonical production path would undermine" >&2
    echo "   the production crypto floor (security-review-2026-05-20-02)." >&2
    exit 64  # EX_USAGE
  fi
  if [[ "${effective_out_dir}" != "${EXPECTED_WEAK_OUT_DIR}" ]]; then
    echo "⚠️  WARNING: MOSAIC_WASM_OUT_DIR=${effective_out_dir} for weak-kdf build" >&2
    echo "   recommended path is ${EXPECTED_WEAK_OUT_DIR}" >&2
  fi
fi

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
#     rustup sysroot, INCLUDING the host-specific toolchain triple) into stable
#     relative tokens so embedded path strings do not leak the host filesystem
#     layout or the host target triple.
#   * `lto = "fat"` in [profile.release] is set workspace-wide; combined with
#     codegen-units=1 it yields a single deterministic LTO pass.
# Result: byte-identical apps/web/src/generated/mosaic-wasm/*.wasm on Windows
# and Linux runners. Verified by the wasm-rebuild-invariance CI job.
rustup_home="$(rustup show home 2>/dev/null || echo "${RUSTUP_HOME:-${HOME:-}}/.rustup")"
cargo_home="${CARGO_HOME:-${HOME:-}/.cargo}"
host_triple="$(rustc -Vv | awk '/^host:/{print $2}')"
toolchain_dir="${rustup_home}/toolchains/$(rustc -V | awk '{print $2}')-${host_triple}"
# Some platforms include a different toolchain dir name when rustup uses a
# channel rather than a fixed version; we cover both.
channel_toolchain_dir="${rustup_home}/toolchains/$(rustc -V | awk '{print $2}')"
remap=(
  "--remap-path-prefix=${PROJECT_ROOT}=mosaic"
  "--remap-path-prefix=${cargo_home}=cargo-home"
  "--remap-path-prefix=${toolchain_dir}=rust-toolchain"
  "--remap-path-prefix=${channel_toolchain_dir}=rust-toolchain"
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

# Output directory inside the web app. Defaults to the canonical
# production path; can be overridden (e.g. for the test-only weak-kdf
# artifact at apps/web/src/generated/mosaic-wasm-test-weak). The override
# is interpreted relative to PROJECT_ROOT when given as a relative path.
out_subpath="${MOSAIC_WASM_OUT_DIR:-apps/web/src/generated/mosaic-wasm}"
if [[ "$out_subpath" = /* ]]; then
  web_out_dir="$out_subpath"
else
  web_out_dir="$PROJECT_ROOT/$out_subpath"
fi
mkdir -p "$web_out_dir"
cp "$out_dir/mosaic_wasm.js" "$web_out_dir/"
cp "$out_dir/mosaic_wasm.d.ts" "$web_out_dir/"
cp "$out_dir/mosaic_wasm_bg.wasm" "$web_out_dir/"
cp "$out_dir/mosaic_wasm_bg.wasm.d.ts" "$web_out_dir/"
