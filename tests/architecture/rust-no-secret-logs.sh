#!/usr/bin/env bash
# Rust boundary log redaction guard.
#
# SPEC-CrossPlatformHardening "Secret, PII, and Log Redaction Rules"
# (docs/specs/SPEC-CrossPlatformHardening.md, lines ~83-124) requires:
#   "Rust boundary crates use no `println!`, `eprintln!`, `dbg!`,
#    `tracing::*`, or `log::*` in secret-bearing paths unless a reviewed
#    redaction wrapper is added."
#
# The Mosaic Rust crates carry password buffers, L0/L1/L2 keys, identity
# seeds, epoch seeds, signing seeds, tier keys, share-link wrapping keys,
# wrapped-key plaintext, and decrypted media bytes through their public FFI
# entry points. Any direct logging macro that touches those values is a
# zero-knowledge violation: the crate-internal log goes to stdout/stderr in
# dev, to logcat on Android, and to `console.*` under the WASM target —
# all of which are surfaces the SPEC prohibits.
#
# Walks the production source trees of the workspace boundary crates
# (mosaic-{client,crypto,uniffi,wasm,domain,media}/src/, NOT tests/) and
# fails if any line uses `println!`, `eprintln!`, `dbg!`, `tracing::*` or
# `tracing!` macros, or `log::*`/`log!` macros directly.
#
# Allowed:
#   - Anything under tests/, examples/, benches/ (each crate's non-src
#     trees are excluded by listing only src/).
#   - A line that is preceded (same line OR the immediately previous
#     non-blank line) by a comment containing "SAFETY:" — this is the
#     reviewed-redaction-wrapper escape hatch from the SPEC. Reviewers
#     must justify the diagnostic with a SPEC reference. Any new escape
#     hatch lands with the comment in the same commit as the macro call.
#
# Exit code: 0 if clean, 1 if any violation. Failure messages are printed
# with file:line: prefixes so they hyperlink in IDE/CI consoles.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

CRATE_ROOTS=(
  crates/mosaic-client/src
  crates/mosaic-crypto/src
  crates/mosaic-uniffi/src
  crates/mosaic-wasm/src
  crates/mosaic-domain/src
  crates/mosaic-media/src
)

# Bash regex run via grep -P. We use a non-capturing word-boundary prefix
# `(^|[^A-Za-z0-9_:])` so we don't match e.g. `my_println!` or
# `crate::tracing` paths that aren't logging calls.
PATTERNS=(
  'println'
  'eprintln'
  'dbg'
  'print'
  'eprint'
  'log_path'
  'tracing_path'
  'bare_log'
)

regex_for() {
  case "$1" in
    println)      printf '%s' '(^|[^A-Za-z0-9_:])println!\s*\(' ;;
    eprintln)     printf '%s' '(^|[^A-Za-z0-9_:])eprintln!\s*\(' ;;
    dbg)          printf '%s' '(^|[^A-Za-z0-9_:])dbg!\s*\(' ;;
    print)        printf '%s' '(^|[^A-Za-z0-9_:])print!\s*\(' ;;
    eprint)       printf '%s' '(^|[^A-Za-z0-9_:])eprint!\s*\(' ;;
    log_path)     printf '%s' '(^|[^A-Za-z0-9_:])log::(trace|debug|info|warn|error|log)!\s*\(' ;;
    tracing_path) printf '%s' '(^|[^A-Za-z0-9_:])tracing::(trace|debug|info|warn|error|event|span|instrument)!\s*\(' ;;
    bare_log)     printf '%s' '(^|[^A-Za-z0-9_:])(trace|debug|info|warn|error)!\s*\(' ;;
  esac
}

violations=()

# is_allowed_by_safety_comment <file> <line_number_1based>
# Returns 0 if the call site is whitelisted by a `// SAFETY:` comment on
# the same line or the immediately-preceding non-blank lines (back to the
# first non-comment line).
is_allowed_by_safety_comment() {
  local file="$1"
  local lineno="$2"

  # Same-line comment.
  local line
  line="$(sed -n "${lineno}p" "$file")"
  if printf '%s' "$line" | grep -Pq '//\s*SAFETY:'; then
    return 0
  fi

  # Walk upward through blank-or-comment lines.
  local probe=$((lineno - 1))
  while [[ $probe -ge 1 ]]; do
    local probe_line
    probe_line="$(sed -n "${probe}p" "$file")"
    if [[ -z "${probe_line//[[:space:]]/}" ]]; then
      probe=$((probe - 1))
      continue
    fi
    if printf '%s' "$probe_line" | grep -Pq '^\s*//'; then
      if printf '%s' "$probe_line" | grep -Pq '//\s*SAFETY:'; then
        return 0
      fi
      probe=$((probe - 1))
      continue
    fi
    return 1
  done
  return 1
}

for root in "${CRATE_ROOTS[@]}"; do
  if [[ ! -d "$root" ]]; then
    violations+=("missing expected crate src tree: $root")
    continue
  fi

  while IFS= read -r -d '' rs_file; do
    for pattern_name in "${PATTERNS[@]}"; do
      regex="$(regex_for "$pattern_name")"
      # grep -nP prints "lineno:line" on matches. We feed each match through
      # the SAFETY-comment whitelist. Skip pure-comment lines via -v '^\s*//'.
      while IFS= read -r match; do
        [[ -z "$match" ]] && continue
        lineno="${match%%:*}"
        line_text="${match#*:}"
        # Skip pure comment lines fast.
        if printf '%s' "$line_text" | grep -Pq '^\s*//'; then
          continue
        fi
        if is_allowed_by_safety_comment "$rs_file" "$lineno"; then
          continue
        fi
        violations+=("${rs_file}:${lineno}: direct logging macro '${pattern_name}' is forbidden in Rust boundary code -> ${line_text}")
      done < <(grep -nP "$regex" "$rs_file" 2>/dev/null || true)
    done
  done < <(find "$root" -type f -name '*.rs' -print0)
done

if [[ ${#violations[@]} -gt 0 ]]; then
  echo ''
  echo 'rust-no-secret-logs guard FAILED:' >&2
  for v in "${violations[@]}"; do
    echo "  $v" >&2
  done
  echo '' >&2
  echo 'Background: SPEC-CrossPlatformHardening forbids direct println!/eprintln!/' >&2
  echo 'dbg!/tracing::*/log::* macros in production Rust boundary code (see spec' >&2
  echo 'docs/specs/SPEC-CrossPlatformHardening.md, "Secret, PII, and Log Redaction' >&2
  echo 'Rules"). Route diagnostics through the existing structured FFI error envelopes' >&2
  echo '(ClientError + ClientErrorCode) instead, or annotate the call site with a' >&2
  echo '`// SAFETY: <SPEC reference>` comment after explicit reviewer approval.' >&2
  exit 1
fi

echo 'rust-no-secret-logs guard: OK (no direct logging macros in Rust boundary src/ trees)'
