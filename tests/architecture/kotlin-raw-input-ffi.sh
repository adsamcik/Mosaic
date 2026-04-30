#!/usr/bin/env bash
# Slice 0C raw-input FFI architecture guard.
#
# The Slice 0C bridges (`AndroidRust{LinkKeys,IdentitySeed,AuthChallenge,
# SealedBundle,Content}Api` and their `GeneratedRust*Api` shell-side
# contracts) take raw secret bytes and exist exclusively to drive the
# cross-client `tests/vectors/*.json` byte-equality tests in
# `apps/android-main/src/test/`. Any non-test caller would bypass the
# handle-based crypto pipeline and put raw key/seed material into
# unmanaged Kotlin `ByteArray`s.
#
# This script greps `apps/android-main/src/main/` and
# `apps/android-shell/src/main/` for any reference to the five new bridge
# type names. A non-zero match exits 1.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

# Adapter classes (apps/android-main):
ANDROID_MAIN_TYPES=(
  AndroidRustLinkKeysApi
  AndroidRustIdentitySeedApi
  AndroidRustAuthChallengeApi
  AndroidRustSealedBundleApi
  AndroidRustContentApi
)

# Generated*Api contract interfaces (apps/android-shell). The shell main
# tree may DEFINE them (the bridge files), but no main-tree class is
# allowed to instantiate or implement them — that's the test-only path.
SHELL_API_TYPES=(
  GeneratedRustLinkKeysApi
  GeneratedRustIdentitySeedApi
  GeneratedRustAuthChallengeApi
  GeneratedRustSealedBundleApi
  GeneratedRustContentApi
)

violations=0

# Search apps/android-main/src/main/ for adapter class references.
for type in "${ANDROID_MAIN_TYPES[@]}"; do
  # Allow the file that DEFINES the type (apps/android-main/src/main/.../<type>.kt).
  match=$(
    grep -rln "$type" apps/android-main/src/main/ 2>/dev/null \
      | grep -v "/${type}.kt$" \
      || true
  )
  if [[ -n "$match" ]]; then
    echo "VIOLATION: production code references Slice 0C raw-input adapter '$type':" >&2
    echo "$match" >&2
    violations=$((violations + 1))
  fi
done

# Search apps/android-shell/src/main/ AND apps/android-main/src/main/ for
# Generated*Api INSTANTIATIONS or IMPLEMENTATIONS (excluding the bridge
# definition files themselves).
for type in "${SHELL_API_TYPES[@]}"; do
  bridge_file="GeneratedRust$(echo "${type#GeneratedRust}" | sed 's/Api$/Bridge.kt/')"
  match=$(
    grep -rln "\b${type}\b" apps/android-shell/src/main/ apps/android-main/src/main/ 2>/dev/null \
      | grep -v "/${bridge_file}$" \
      | grep -v "/AndroidRust$(echo "${type#GeneratedRust}" | sed 's/Api$/Api.kt/')$" \
      || true
  )
  if [[ -n "$match" ]]; then
    echo "VIOLATION: production code references Slice 0C raw-input contract '$type':" >&2
    echo "$match" >&2
    violations=$((violations + 1))
  fi
done

if [[ $violations -gt 0 ]]; then
  echo "" >&2
  echo "kotlin-raw-input-ffi guard found $violations violation(s)." >&2
  echo "The Slice 0C bridges are test-only — see docs/specs/SPEC-AndroidSlice0CCryptoBridges.md" >&2
  exit 1
fi

echo "kotlin-raw-input-ffi guard: OK (no production callers of Slice 0C raw-input bridges)"
