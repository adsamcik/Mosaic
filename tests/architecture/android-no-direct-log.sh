#!/usr/bin/env bash
# Android no-direct-log architecture guard.
#
# Enforces the "Android shell" slice of SPEC-CrossPlatformHardening's
# "Secret, PII, and Log Redaction Rules". Production Kotlin code in the
# Android shell + Android Gradle module must NOT call:
#   - android.util.Log.{v,d,i,w,e,wtf}
#   - Timber.*
#   - top-level kotlin println / print (or kotlin.io.println explicit imports)
#
# These APIs route to logcat / stdout without redaction wrappers. A future
# centralized logger will own the runtime path; until then any direct call
# is treated as a privacy regression.
#
# Allowed paths (NOT scanned):
#   - src/test/, src/androidTest/  (test sources may use println for PASS/FAIL)
#   - generated source under build/generated/ (UniFFI bindings)
#
# Exit code:
#   0  no violations
#   1  one or more violations; lines are printed as file:line  pattern  text
#
# This guard joins the family of:
#   - tests/architecture/rust-boundaries.{ps1,sh}
#   - tests/architecture/kotlin-raw-input-ffi.{ps1,sh}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

ROOTS=(
  "apps/android-shell/src/main/kotlin"
  "apps/android-main/src/main/kotlin"
)

# Pattern table: parallel arrays of NAME / PCRE.
# Notes:
#   - Patterns use Perl-compatible lookbehind (-P) so we can require that
#     `Log.X(`, `println(`, etc. are NOT preceded by an identifier or `.`
#     character. This excludes member-style calls like `myList.print()`
#     or our own `imprint(...)`/`Snapshot.print()`.
#   - We strip line-level comments before pattern matching to avoid flagging
#     KDoc / `// comment` text discussing example calls.
PATTERN_NAMES=(
  "android.util.Log import"
  "Log.v("
  "Log.d("
  "Log.i("
  "Log.w("
  "Log.e("
  "Log.wtf("
  "Timber."
  "kotlin.io.println("
  "kotlin.io.print("
  "top-level println("
  "top-level print("
)

PATTERN_REGEXES=(
  '\bandroid\.util\.Log\b'
  '(?<![A-Za-z0-9_.])Log\.v\s*\('
  '(?<![A-Za-z0-9_.])Log\.d\s*\('
  '(?<![A-Za-z0-9_.])Log\.i\s*\('
  '(?<![A-Za-z0-9_.])Log\.w\s*\('
  '(?<![A-Za-z0-9_.])Log\.e\s*\('
  '(?<![A-Za-z0-9_.])Log\.wtf\s*\('
  '(?<![A-Za-z0-9_.])Timber\.'
  '\bkotlin\.io\.println\s*\('
  '\bkotlin\.io\.print\s*\('
  '(?<![A-Za-z0-9_.])println\s*\('
  '(?<![A-Za-z0-9_.])print\s*\('
)

# Build the existing-roots list (skip silently if any root is missing — the
# Android Gradle module may be absent in some clones).
EXISTING_ROOTS=()
for root in "${ROOTS[@]}"; do
  if [[ -d "$root" ]]; then EXISTING_ROOTS+=("$root"); fi
done

if [[ "${#EXISTING_ROOTS[@]}" -eq 0 ]]; then
  echo "android-no-direct-log guard: SKIP (no Android Kotlin source roots present)"
  exit 0
fi

violations_count=0
violations_text=""

# One grep invocation per pattern across all roots is dramatically faster than
# a per-line shell loop (avoids ~10k subshell spawns on Git Bash for Windows).
# Each grep emits `path:line:text`; we apply the allow-list and comment-strip
# in a single AWK pass.
for i in "${!PATTERN_NAMES[@]}"; do
  pattern_name="${PATTERN_NAMES[$i]}"
  pattern_regex="${PATTERN_REGEXES[$i]}"

  # `|| true` so a no-match grep (exit 1) does not abort under `set -e`.
  matches="$(grep -rPHn --include='*.kt' "$pattern_regex" "${EXISTING_ROOTS[@]}" 2>/dev/null || true)"
  if [[ -z "$matches" ]]; then continue; fi

  while IFS= read -r match; do
    # `match` looks like: `path:lineNumber:text` (path may contain colons on
    # Windows like `apps/android-...`, but never a `:` other than the AWK
    # field separator after the line number, since git-bash uses POSIX paths).
    file="${match%%:*}"
    rest="${match#*:}"
    line_number="${rest%%:*}"
    raw_text="${rest#*:}"

    # Allow-list: skip test sources and generated bindings.
    case "$file" in
      */src/test/*|*/src/androidTest/*|*/build/generated/*) continue ;;
    esac

    # Strip line-level comments so KDoc / `// example: Log.d(...)` does not
    # trip the guard. We re-test the trimmed line against the same pattern
    # to confirm the match is in actual code, not a comment.
    code_part="${raw_text%%//*}"
    if [[ -z "${code_part//[[:space:]]/}" ]]; then continue; fi
    if ! printf '%s' "$code_part" | grep -P -q "$pattern_regex"; then continue; fi

    trimmed="${raw_text%$'\r'}"
    violations_text+="  ${file}:${line_number}  [${pattern_name}]  ${trimmed}"$'\n'
    violations_count=$((violations_count + 1))
  done <<< "$matches"
done

if [[ "$violations_count" -gt 0 ]]; then
  echo "" >&2
  echo "android-no-direct-log guard found direct logging in production Kotlin sources:" >&2
  printf '%s' "$violations_text" >&2
  echo "" >&2
  echo "These calls bypass redaction and route raw text to logcat / stdout." >&2
  echo "Move the call into the centralized logger seam, or relocate the" >&2
  echo "code to src/test/ or src/androidTest/ where println PASS/FAIL" >&2
  echo "markers are intentionally allowed." >&2
  echo "" >&2
  echo "android-no-direct-log guard: FAIL (${violations_count} violation(s))" >&2
  exit 1
fi

echo "android-no-direct-log guard: OK (no direct logging in Android production Kotlin sources)"
