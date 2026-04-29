#!/usr/bin/env bash
# Run JVM unit tests for the Mosaic Android Gradle module (`apps/android-main`).
#
# Runs `./gradlew :apps:android-main:testDebugUnitTest`. These tests run on the
# JVM (no emulator) and exercise adapter class compilation against generated
# UniFFI bindings + compile-time wiring between `AndroidRust*Api` adapters and
# the shell's `GeneratedRust*Api` interfaces.
#
# Instrumented tests (`androidTest/`) require a running emulator and are not
# invoked here.

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$( cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd )"

GRADLEW="$PROJECT_ROOT/gradlew"
if [[ ! -x "$GRADLEW" ]]; then
    echo "Gradle wrapper not found or not executable at $GRADLEW" >&2
    exit 1
fi

echo "==> Running apps/android-main JVM unit tests"
"$GRADLEW" ":apps:android-main:testDebugUnitTest" --no-daemon --console=plain

echo "==> apps/android-main JVM tests green"
