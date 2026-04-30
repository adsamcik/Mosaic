#!/usr/bin/env bash
# Web direct-console architecture guard.
#
# Implements the "Secret, PII, and Log Redaction Rules" web slice of
# docs/specs/SPEC-CrossPlatformHardening.md (lines ~111-113):
#
#   "Web production code uses the centralized logger only; no `console.*`
#    calls in high-risk crypto/storage/upload boundaries."
#
# This script walks the high-risk web boundary directories listed below
# and FAILS if any production source file uses `console.log`,
# `console.warn`, `console.error`, `console.info`, `console.debug`, or
# `console.trace`. The single allowed callsite is
# `apps/web/src/lib/logger.ts` itself (the centralized logger).
#
# Exit code 0 if clean, 1 if any violation. Mirrors
# `tests/architecture/rust-boundaries.sh` and
# `tests/architecture/kotlin-raw-input-ffi.sh` conventions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

# High-risk roots — boundaries where a `console.*` regression would
# bypass the centralized logger's redaction guarantees and risk leaking
# secrets / PII / raw URIs / plaintext metadata.
#
# Format per entry: "<path>|<recurse:0|1>|<glob>" where glob is "*"
# (any .ts/.tsx in path) or a specific filename pattern.
HIGH_RISK_TARGETS=(
  "apps/web/src/workers|1|*"
  "apps/web/src/lib|0|*-service.ts"
  "apps/web/src/lib|0|sync-engine.ts"
  "apps/web/src/lib|0|sync-coordinator.ts"
  "apps/web/src/lib|0|sync-coordinator.tsx"
  "apps/web/src/lib|0|shared-album-download.ts"
  "apps/web/src/lib|0|local-purge.ts"
  "apps/web/src/lib|0|api.ts"
  "apps/web/src/lib|0|key-cache.ts"
  "apps/web/src/lib|0|epoch-key-store.ts"
  "apps/web/src/lib|0|epoch-key-service.ts"
  "apps/web/src/lib|0|epoch-rotation-service.ts"
  "apps/web/src/contexts|0|SyncContext.tsx"
  "apps/web/src/contexts|0|AlbumContentContext.tsx"
)

# Allowlist (POSIX-style relative paths). The centralized logger is the
# sanctioned `console.*` callsite; tests and dev scripts are always
# allowed.
ALLOWED_PATTERNS=(
  "*/__tests__/*"
  "*.test.ts"
  "*.test.tsx"
  "*/scripts/*"
  "apps/web/src/lib/logger.ts"
)

CONSOLE_REGEX='\bconsole\.(log|warn|error|info|debug|trace)[[:space:]]*\('

is_allowed() {
  local rel="$1"
  for pat in "${ALLOWED_PATTERNS[@]}"; do
    # shellcheck disable=SC2053 -- intentional glob match
    if [[ "$rel" == $pat ]]; then
      return 0
    fi
  done
  return 1
}

collect_candidates() {
  local entry="$1"
  local path="${entry%%|*}"
  local rest="${entry#*|}"
  local recurse="${rest%%|*}"
  local glob="${rest#*|}"

  if [[ ! -d "$path" ]]; then
    return 0
  fi

  if [[ "$glob" == "*" ]]; then
    # All TS/TSX files
    if [[ "$recurse" == "1" ]]; then
      find "$path" -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null
    else
      find "$path" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null
    fi
  else
    # Specific filename pattern
    if [[ "$recurse" == "1" ]]; then
      find "$path" -type f -name "$glob" 2>/dev/null
    else
      find "$path" -maxdepth 1 -type f -name "$glob" 2>/dev/null
    fi
  fi
}

violations=()

# De-duplicate candidate files (some entries may overlap).
declare -A SEEN

for entry in "${HIGH_RISK_TARGETS[@]}"; do
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if [[ -n "${SEEN[$file]+x}" ]]; then continue; fi
    SEEN[$file]=1

    # Make path relative + POSIX-style
    rel="${file#"$PROJECT_ROOT"/}"
    rel="${rel//\\//}"

    if is_allowed "$rel"; then continue; fi

    # Scan for executable console.* calls. Skip lines that begin with a
    # comment marker (//, *, /*) so doc snippets inside JSDoc don't
    # trigger false positives.
    while IFS= read -r match; do
      [[ -z "$match" ]] && continue
      lineno="${match%%:*}"
      content="${match#*:}"
      trimmed="$(printf '%s' "$content" | sed -E 's/^[[:space:]]+//')"
      case "$trimmed" in
        //*|\**|/\**) continue ;;
      esac
      violations+=("${rel}:${lineno}: ${trimmed}")
    done < <(grep -nE "$CONSOLE_REGEX" "$file" 2>/dev/null || true)
  done < <(collect_candidates "$entry")
done

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "" >&2
  echo "VIOLATION: direct console.* call(s) found in high-risk web boundary code." >&2
  echo "Use the centralized logger from apps/web/src/lib/logger.ts instead." >&2
  echo "" >&2
  for v in "${violations[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "web-no-direct-console guard found ${#violations[@]} violation(s)." >&2
  exit 1
fi

echo "web-no-direct-console guard: OK (no direct console.* calls in high-risk web boundaries)"
exit 0
