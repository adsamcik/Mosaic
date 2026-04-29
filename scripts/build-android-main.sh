#!/usr/bin/env bash
# Build the Mosaic Android Gradle module (`apps/android-main`).
#
# Orchestrates the full Android pipeline:
#   1. Builds the Rust UniFFI core for arm64-v8a + x86_64 ABIs and
#      generates Kotlin bindings via `scripts/build-rust-android.sh`.
#   2. Runs `./gradlew :apps:android-main:assembleDebug` to produce the APK.
#
# The Gradle pre-build task (`buildRustUniffiArtifacts`) also calls
# `build-rust-android.sh` internally, so the explicit invocation here is
# primarily a fast-fail probe: if Rust compilation breaks, it is clearer to
# surface the cargo error directly than to discover it inside Gradle.
#
# Flags:
#   --skip-rust   Skip the explicit `build-rust-android.sh` invocation.

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$( cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd )"

SKIP_RUST=0
for arg in "$@"; do
    case "$arg" in
        --skip-rust) SKIP_RUST=1 ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

if [[ "$SKIP_RUST" -eq 0 ]]; then
    echo "==> Building Rust UniFFI artifacts (Android targets + Kotlin bindings)"
    "$SCRIPT_DIR/build-rust-android.sh"
fi

echo "==> Assembling apps/android-main (debug APK)"
GRADLEW="$PROJECT_ROOT/gradlew"
if [[ ! -x "$GRADLEW" ]]; then
    echo "Gradle wrapper not found or not executable at $GRADLEW" >&2
    exit 1
fi

"$GRADLEW" ":apps:android-main:assembleDebug" --no-daemon --console=plain

APK="$PROJECT_ROOT/apps/android-main/build/outputs/apk/debug/android-main-debug.apk"
if [[ ! -f "$APK" ]]; then
    echo "Expected APK not produced at $APK" >&2
    exit 1
fi

SIZE=$(stat -c%s "$APK" 2>/dev/null || stat -f%z "$APK")
SIZE_MB=$(awk -v s="$SIZE" 'BEGIN { printf "%.2f", s / 1048576 }')
echo "APK: $APK (${SIZE_MB} MB)"
