#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WASM_BINDGEN_VERSION="0.2.118"
cd "$PROJECT_ROOT"

# Security guard (HIGH security-review-2026-05-20-02 + -03): the `weak-kdf`
# cargo feature relaxes Argon2id to a test-only profile (8 MiB / 1 iter).
# Bytes built with it MUST NOT land at the canonical production output path
# (apps/web/src/generated/mosaic-wasm) — otherwise a production bundle could
# silently inherit the relaxed KDF floor. The previous guard compared raw
# strings, which could be bypassed with `./`, `..`, trailing separators,
# absolute aliases, or symlinks. We now resolve both sides to canonical
# absolute paths (with symlink resolution) BEFORE comparing.
CANONICAL_OUT_DIR="apps/web/src/generated/mosaic-wasm"
EXPECTED_WEAK_OUT_DIR="apps/web/src/generated/mosaic-wasm-test-weak"

# Canonicalize a path: resolve `.`, `..`, repeated slashes, trailing
# separators, AND symlinks. Works for paths that don't exist yet. Prefers
# `realpath -m` (GNU coreutils, available in Linux + Docker container);
# falls back to python3, then a best-effort cd+pwd -P.
canonicalize_path() {
  local p="$1"
  if command -v realpath >/dev/null 2>&1; then
    if out="$(realpath -m -- "$p" 2>/dev/null)"; then echo "$out"; return; fi
  fi
  if command -v python3 >/dev/null 2>&1; then
    if out="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null)"; then
      echo "$out"; return
    fi
  fi
  if command -v python >/dev/null 2>&1; then
    if out="$(python -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null)"; then
      echo "$out"; return
    fi
  fi
  if [[ -d "$p" ]]; then (cd "$p" && pwd -P); return; fi
  local parent base
  parent="$(dirname "$p")"
  base="$(basename "$p")"
  if [[ -d "$parent" ]]; then
    echo "$(cd "$parent" && pwd -P)/$base"
  else
    echo "$p"
  fi
}

repo_root_abs="$(cd "$PROJECT_ROOT" && pwd -P)"
canonical_abs="$(canonicalize_path "$repo_root_abs/$CANONICAL_OUT_DIR")"
expected_weak_abs="$(canonicalize_path "$repo_root_abs/$EXPECTED_WEAK_OUT_DIR")"

if [[ ",${MOSAIC_WASM_CARGO_FEATURES:-}," == *",weak-kdf,"* ]]; then
  effective_out_dir_raw="${MOSAIC_WASM_OUT_DIR:-$CANONICAL_OUT_DIR}"
  # Promote to absolute relative to repo root before canonicalizing.
  case "$effective_out_dir_raw" in
    /*) effective_abs_input="$effective_out_dir_raw" ;;
    *)  effective_abs_input="$repo_root_abs/$effective_out_dir_raw" ;;
  esac
  effective_abs="$(canonicalize_path "$effective_abs_input")"

  if [[ "$effective_abs" == "$canonical_abs" ]]; then
    echo "❌ ERROR: weak-kdf feature must NOT write to the canonical production path." >&2
    echo "   canonical: $canonical_abs" >&2
    echo "   requested: $effective_abs (raw: $effective_out_dir_raw)" >&2
    echo "   Writing weak-kdf bytes there would undermine the production crypto floor" >&2
    echo "   (security-review-2026-05-20-02 + -03)." >&2
    exit 64  # EX_USAGE
  fi
  if [[ "$effective_abs" != "$expected_weak_abs" ]]; then
    echo "❌ ERROR: weak-kdf builds must write to $EXPECTED_WEAK_OUT_DIR." >&2
    echo "   expected: $expected_weak_abs" >&2
    echo "   requested: $effective_abs (raw: $effective_out_dir_raw)" >&2
    exit 64
  fi
  # Symlink defense-in-depth: refuse if the raw path is a symlink whose
  # ultimate target is the canonical production directory.
  if [[ -L "$effective_abs_input" ]]; then
    if command -v readlink >/dev/null 2>&1; then
      link_target="$(readlink -f -- "$effective_abs_input" 2>/dev/null || true)"
      if [[ -n "$link_target" && "$link_target" == "$canonical_abs" ]]; then
        echo "❌ ERROR: MOSAIC_WASM_OUT_DIR is a symlink resolving to canonical production path." >&2
        echo "   link: $effective_abs_input -> $link_target" >&2
        exit 64
      fi
    fi
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
