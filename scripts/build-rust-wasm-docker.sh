#!/usr/bin/env bash
# Deterministic Rust→WASM build via Docker.
#
# Closes `sweep42-followup-wasm-determinism`. Native rustc builds drift
# ~150 bytes between Windows hosts and Linux hosts even at the same
# pinned 1.93.1 toolchain. This wrapper runs the build inside the
# pinned `mosaic-wasm-build:1.93.1` image (see
# `scripts/Dockerfile.wasm-build`) so every contributor — and CI —
# produces the same bytes.
#
# Behavior:
#   * Builds the image on first run (subsequent runs are cached).
#   * Mounts the repo read/write at /work and runs
#     `scripts/build-rust-wasm.sh` inside the container.
#   * Emits artifacts to `apps/web/src/generated/mosaic-wasm/`
#     identical to what CI's `Build Check` job writes.
#
# To rebuild the image from scratch (e.g. after editing the Dockerfile):
#   docker build -f scripts/Dockerfile.wasm-build -t mosaic-wasm-build:1.93.1 scripts/
#
# To run the build:
#   bash scripts/build-rust-wasm-docker.sh
#
# To pass cargo features (e.g. weak-kdf for fast E2E builds):
#   MOSAIC_WASM_CARGO_FEATURES=weak-kdf bash scripts/build-rust-wasm-docker.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
IMAGE_TAG="mosaic-wasm-build:1.93.1"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for deterministic WASM builds." >&2
  echo "On Windows install Docker Desktop; on Linux install docker-ce." >&2
  exit 1
fi

# Security guard (HIGH security-review-2026-05-20-02 + -03): reject weak-kdf
# builds that would land in the canonical production WASM path BEFORE we
# even spin up the build container. Canonicalizes both sides to defeat
# `./`, `..`, trailing separators, absolute aliases, and symlinks. The
# inner script enforces this too; we fail fast for a clearer error.
CANONICAL_OUT_DIR="apps/web/src/generated/mosaic-wasm"
EXPECTED_WEAK_OUT_DIR="apps/web/src/generated/mosaic-wasm-test-weak"

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
  case "$effective_out_dir_raw" in
    /*) effective_abs_input="$effective_out_dir_raw" ;;
    *)  effective_abs_input="$repo_root_abs/$effective_out_dir_raw" ;;
  esac
  effective_abs="$(canonicalize_path "$effective_abs_input")"
  if [[ "$effective_abs" == "$canonical_abs" ]]; then
    echo "❌ ERROR: weak-kdf feature must NOT write to the canonical production path." >&2
    echo "   canonical: $canonical_abs" >&2
    echo "   requested: $effective_abs (raw: $effective_out_dir_raw)" >&2
    exit 64
  fi
  if [[ "$effective_abs" != "$expected_weak_abs" ]]; then
    echo "❌ ERROR: weak-kdf builds must write to $EXPECTED_WEAK_OUT_DIR." >&2
    echo "   expected: $expected_weak_abs" >&2
    echo "   requested: $effective_abs (raw: $effective_out_dir_raw)" >&2
    exit 64
  fi
  if [[ -L "$effective_abs_input" ]]; then
    if command -v readlink >/dev/null 2>&1; then
      link_target="$(readlink -f -- "$effective_abs_input" 2>/dev/null || true)"
      if [[ -n "$link_target" && "$link_target" == "$canonical_abs" ]]; then
        echo "❌ ERROR: MOSAIC_WASM_OUT_DIR is a symlink resolving to canonical production path." >&2
        exit 64
      fi
    fi
  fi
fi

# Build (or refresh) the image if it does not already exist locally.
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "[wasm-docker] image $IMAGE_TAG not found, building..." >&2
  docker build -f "$SCRIPT_DIR/Dockerfile.wasm-build" -t "$IMAGE_TAG" "$SCRIPT_DIR"
fi

# Pass through MOSAIC_WASM_CARGO_FEATURES so callers can flip on
# weak-kdf for fast E2E builds without bypassing the deterministic
# wrapper.
env_args=()
if [[ -n "${MOSAIC_WASM_CARGO_FEATURES:-}" ]]; then
  env_args+=(-e "MOSAIC_WASM_CARGO_FEATURES=$MOSAIC_WASM_CARGO_FEATURES")
fi
if [[ -n "${MOSAIC_WASM_OUT_DIR:-}" ]]; then
  env_args+=(-e "MOSAIC_WASM_OUT_DIR=$MOSAIC_WASM_OUT_DIR")
fi

echo "[wasm-docker] running deterministic WASM build inside $IMAGE_TAG..." >&2
docker run --rm \
  -v "$PROJECT_ROOT":/work \
  "${env_args[@]}" \
  "$IMAGE_TAG"
