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

ALLOWED_FIXTURE_EMAILS=(
  'test@example.com'
)
PII_EMAIL_ROOTS=(
  'apps/android-main/src/main'
  'apps/android-shell/src/main'
  'apps/android-main/src/test'
)
PII_PRODUCTION_ROOTS=(
  'apps/android-main/src/main'
  'apps/android-shell/src/main'
)
PII_EMAIL_REGEX='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
PII_PHONE_REGEX='(?<![\w+])\+[1-9]\d{7,14}(?!\w)'
PII_CAMERA_FILE_REGEX='IMG_\d{8}_[A-Za-z0-9_-]+\.jpe?g'
PII_PATTERN_SOURCE_ALLOW_LIST=(
  'MosaicPiiPatterns.kt'
  'PrivacyAuditorTest.kt'
)

is_allowed_fixture_email() {
  local email="$1"
  for allowed in "${ALLOWED_FIXTURE_EMAILS[@]}"; do
    if [[ "$email" == "$allowed" ]]; then return 0; fi
  done
  return 1
}

is_pii_pattern_source() {
  local file="$1"
  for suffix in "${PII_PATTERN_SOURCE_ALLOW_LIST[@]}"; do
    if [[ "$file" == *"$suffix" ]]; then return 0; fi
  done
  return 1
}

assert_pii_regex_fixtures() {
  if ! printf '%s' 'owner@example.org' | grep -Pq "$PII_EMAIL_REGEX"; then
    echo "kotlin-raw-input-ffi PII fixture failed to catch email regex" >&2
    exit 1
  fi
  if ! printf '%s' '+420123456789' | grep -Pq "$PII_PHONE_REGEX"; then
    echo "kotlin-raw-input-ffi PII fixture failed to catch E.164 phone regex" >&2
    exit 1
  fi
  if ! printf '%s' 'IMG_20260509_secret.jpg' | grep -Pq "$PII_CAMERA_FILE_REGEX"; then
    echo "kotlin-raw-input-ffi PII fixture failed to catch camera filename regex" >&2
    exit 1
  fi
}

assert_pii_regex_fixtures

for root in "${PII_EMAIL_ROOTS[@]}"; do
  [[ -d "$root" ]] || continue
  while IFS= read -r -d '' kt_file; do
    if is_pii_pattern_source "$kt_file"; then continue; fi
    matches="$(grep -Po "$PII_EMAIL_REGEX" "$kt_file" 2>/dev/null || true)"
    [[ -n "$matches" ]] || continue
    while IFS= read -r email; do
      [[ -n "$email" ]] || continue
      if is_allowed_fixture_email "$email"; then continue; fi
      echo "VIOLATION: hard-coded email-like PII '$email' in $kt_file. Use test@example.com for fixtures." >&2
      violations=$((violations + 1))
    done <<< "$matches"
  done < <(find "$root" -type f -name '*.kt' -print0 2>/dev/null)
done

for root in "${PII_PRODUCTION_ROOTS[@]}"; do
  [[ -d "$root" ]] || continue
  while IFS= read -r -d '' kt_file; do
    if is_pii_pattern_source "$kt_file"; then continue; fi
    if grep -Pq "$PII_PHONE_REGEX" "$kt_file" 2>/dev/null; then
      echo "VIOLATION: hard-coded E.164 phone-like PII in $kt_file." >&2
      violations=$((violations + 1))
    fi
    if grep -Pq "$PII_CAMERA_FILE_REGEX" "$kt_file" 2>/dev/null; then
      echo "VIOLATION: hard-coded Android camera filename-like PII in $kt_file." >&2
      violations=$((violations + 1))
    fi
  done < <(find "$root" -type f -name '*.kt' -print0 2>/dev/null)
done

if [[ $violations -gt 0 ]]; then
  echo "" >&2
  echo "kotlin-raw-input-ffi guard found $violations violation(s)." >&2
  echo "The Slice 0C bridges are test-only — see docs/specs/SPEC-AndroidSlice0CCryptoBridges.md" >&2
  exit 1
fi

echo "kotlin-raw-input-ffi guard: OK (no production callers of Slice 0C raw-input bridges)"
