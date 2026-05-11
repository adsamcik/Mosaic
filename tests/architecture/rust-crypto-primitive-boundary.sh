#!/usr/bin/env bash
# Rust crypto primitive boundary guard.
#
# Protocol cryptography must live in mosaic-crypto. Facade, domain, media,
# client, and vector crates may call mosaic_crypto APIs, but must not import
# low-level primitive crates directly unless a reviewed allowlist classifier is
# present for the file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

CRATE_ROOTS=(
  crates/mosaic-wasm/src
  crates/mosaic-uniffi/src
  crates/mosaic-domain/src
  crates/mosaic-media/src
  crates/mosaic-client/src
  crates/mosaic-vectors/src
)

declare -A ALLOWED_FILES=(
)

PATTERN_NAMES=(
  primitive_crate_import
)

PATTERN_REGEXES=(
  '\buse\s+(sha2|sha1|blake2|hkdf|hmac|chacha20(poly1305)?|aes_gcm|xchacha20poly1305|ed25519(_dalek)?|x25519(_dalek)?|argon2|crypto_secretbox|pbkdf2|generic_array|hybrid_array)\s*(::|\{)'
)

regex_for() {
  case "$1" in
    primitive_crate_import) printf '%s' "${PATTERN_REGEXES[0]}" ;;
  esac
}

is_allowed() {
  local file="$1"
  local classifier="${ALLOWED_FILES[$file]:-}"
  [[ -n "$classifier" ]] || return 1
  if ! printf '%s' "$classifier" | grep -Pq '^(SAFE|MIGRATION-PENDING|BOUNDARY):\s+\S'; then
    echo "rust-crypto-primitive-boundary allowlist entry for '$file' must start with SAFE:, MIGRATION-PENDING:, or BOUNDARY:" >&2
    exit 1
  fi
  return 0
}

assert_pattern_fixture_caught() {
  local name="$1"
  local source="$2"
  local expected="$3"
  local regex
  regex="$(regex_for "$expected")"
  if ! printf '%s' "$source" | grep -Pq "$regex"; then
    echo "rust-crypto-primitive-boundary negative fixture '$name' did not catch expected pattern '$expected'" >&2
    exit 1
  fi
}

assert_pattern_fixture_caught 'sha2-import' 'use sha2::{Digest, Sha256};' 'primitive_crate_import'
assert_pattern_fixture_caught 'hkdf-import' 'use hkdf::Hkdf;' 'primitive_crate_import'
assert_pattern_fixture_caught 'ed25519-import' 'use ed25519_dalek::SigningKey;' 'primitive_crate_import'

violations=()

for root in "${CRATE_ROOTS[@]}"; do
  if [[ ! -d "$root" ]]; then
    violations+=("Missing expected crate src tree: $root")
    continue
  fi

  while IFS= read -r -d '' rs_file; do
    if is_allowed "$rs_file"; then
      continue
    fi
    for pattern_name in "${PATTERN_NAMES[@]}"; do
      regex="$(regex_for "$pattern_name")"
      while IFS= read -r match; do
        [[ -z "$match" ]] && continue
        lineno="${match%%:*}"
        line_text="${match#*:}"
        if printf '%s' "$line_text" | grep -Pq '^\s*//'; then
          continue
        fi
        violations+=("${rs_file}:${lineno}: direct crypto primitive import '${pattern_name}' is forbidden outside mosaic-crypto -> ${line_text}")
      done < <(grep -nP "$regex" "$rs_file" 2>/dev/null || true)
    done
  done < <(find "$root" -type f -name '*.rs' -print0)
done

if [[ ${#violations[@]} -gt 0 ]]; then
  echo ''
  echo 'rust-crypto-primitive-boundary guard FAILED:' >&2
  printf '  %s\n' "${violations[@]}" | sort -u >&2
  echo '' >&2
  echo 'Low-level crypto primitives must route through mosaic-crypto or an explicit SAFE/MIGRATION-PENDING/BOUNDARY allowlist.' >&2
  exit 1
fi

echo 'rust-crypto-primitive-boundary guard: OK (Rust crypto primitives route through mosaic-crypto)'
