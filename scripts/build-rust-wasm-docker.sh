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

echo "[wasm-docker] running deterministic WASM build inside $IMAGE_TAG..." >&2
docker run --rm \
  -v "$PROJECT_ROOT":/work \
  "${env_args[@]}" \
  "$IMAGE_TAG"
