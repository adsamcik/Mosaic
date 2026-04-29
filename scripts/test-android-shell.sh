#!/usr/bin/env bash
# Run the JVM-only Android shell foundation tests (Kotlin/JVM, no Gradle, no Android SDK).
#
# Linux parity for `scripts/test-android-shell.ps1`. Resolves `kotlinc`/`kotlin`
# from PATH or the explicit `--kotlin-home` argument. CI usually installs Kotlin
# via `apt-get` (`kotlin` package) which puts kotlinc on PATH. Locally,
# Android Studio bundles Kotlin under `<studio>/plugins/Kotlin/kotlinc/bin/`.
#
# Flags:
#   --kotlin-home <dir>    Explicit Kotlin install dir (containing `bin/kotlinc`).

set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$( cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd )"
MODULE_ROOT="$PROJECT_ROOT/apps/android-shell"
BUILD_ROOT="$MODULE_ROOT/build"
CLASSES_DIR="$BUILD_ROOT/test-classes"

KOTLIN_HOME_OVERRIDE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --kotlin-home)
            KOTLIN_HOME_OVERRIDE="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

resolve_kotlin_command() {
    local cmd="$1"
    if [[ -n "$KOTLIN_HOME_OVERRIDE" ]]; then
        local candidate="$KOTLIN_HOME_OVERRIDE/bin/$cmd"
        if [[ -x "$candidate" ]]; then
            echo "$candidate"
            return 0
        fi
    fi
    if [[ -n "${KOTLIN_HOME:-}" ]]; then
        local candidate="$KOTLIN_HOME/bin/$cmd"
        if [[ -x "$candidate" ]]; then
            echo "$candidate"
            return 0
        fi
    fi
    if command -v "$cmd" >/dev/null 2>&1; then
        command -v "$cmd"
        return 0
    fi
    echo "Unable to find $cmd. Pass --kotlin-home, set KOTLIN_HOME, or add Kotlin to PATH." >&2
    return 1
}

KOTLINC=$(resolve_kotlin_command kotlinc)
KOTLIN=$(resolve_kotlin_command kotlin)
KOTLIN_COMPILER_HOME="$( cd -- "$( dirname -- "$KOTLINC" )/.." &> /dev/null && pwd )"
KOTLIN_STDLIB="$KOTLIN_COMPILER_HOME/lib/kotlin-stdlib.jar"
if [[ ! -f "$KOTLIN_STDLIB" ]]; then
    echo "Unable to find Kotlin stdlib at $KOTLIN_STDLIB" >&2
    exit 1
fi

rm -rf "$CLASSES_DIR"
mkdir -p "$CLASSES_DIR"

mapfile -t SOURCES < <(
    find "$MODULE_ROOT/src/main/kotlin" "$MODULE_ROOT/src/test/kotlin" -type f -name '*.kt' 2>/dev/null | sort
)
if [[ "${#SOURCES[@]}" -eq 0 ]]; then
    echo "No Kotlin sources found under $MODULE_ROOT" >&2
    exit 1
fi

echo "==> Compiling Android shell Kotlin/JVM tests"
"$KOTLINC" "${SOURCES[@]}" -classpath "$KOTLIN_STDLIB" -d "$CLASSES_DIR" -jvm-target 17

TEST_SOURCE_ROOT="$MODULE_ROOT/src/test/kotlin"
mapfile -t TEST_FILES < <(find "$TEST_SOURCE_ROOT" -type f -name '*Test.kt' | sort)

echo "==> Running Android shell foundation tests"
for test_file in "${TEST_FILES[@]}"; do
    rel_path="${test_file#$TEST_SOURCE_ROOT/}"
    rel_dir="$(dirname "$rel_path")"
    base="$(basename "$rel_path" .kt)"
    if [[ "$rel_dir" == "." ]]; then
        main_class="${base}Kt"
    else
        package="${rel_dir//\//.}"
        main_class="${package}.${base}Kt"
    fi
    "$KOTLIN" -classpath "$CLASSES_DIR:$KOTLIN_STDLIB" "$main_class"
done
