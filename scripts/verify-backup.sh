#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

MOSAIC_UTILITY_IMAGE="postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"

fail() { echo "backup verification: $*" >&2; exit 1; }
step() { echo "▶ $*"; }
done_message() { echo "✅ $*"; }

require_docker() {
  docker info > /dev/null 2>&1 || fail "Docker must be running"
}

sha256_file() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "Neither sha256sum nor shasum is available"
  fi
}

verify_pair_manifest() {
  local database_hash blob_hash expected actual
  database_hash="$(sha256_file "$BACKUP_DIR/database.dump")"
  blob_hash="$(sha256_file "$BACKUP_DIR/blobs.tar.gz")"
  expected="$(printf "%s  database.dump\n%s  blobs.tar.gz" "$database_hash" "$blob_hash")"
  actual="$(tr -d '\r' < "$BACKUP_DIR/manifest.sha256")"
  [ "$actual" = "$expected" ]
}

validate_blob_archive() {
  docker run --rm --network none -v "$BACKUP_DIR:/backup:ro" "$MOSAIC_UTILITY_IMAGE" sh -eu -c '
    tar tzf /backup/blobs.tar.gz > /tmp/mosaic-archive-members
    while IFS= read -r member; do
      case "$member" in
        "."|"./") ;;
        ./*)
          case "$member" in
            *"/../"*|*"/.."|*"\\"*)
              echo "unsafe blob archive member: $member" >&2
              exit 1
              ;;
          esac
          ;;
        *)
          echo "unsafe blob archive member: $member" >&2
          exit 1
          ;;
      esac
    done < /tmp/mosaic-archive-members
    tar tvzf /backup/blobs.tar.gz > /tmp/mosaic-archive-details
    while IFS= read -r detail; do
      case "$detail" in
        -*|d*) ;;
        *)
          echo "unsafe non-file archive member: $detail" >&2
          exit 1
          ;;
      esac
    done < /tmp/mosaic-archive-details
  '
}

verify_inventory_stream() {
  local blob_volume="$1"
  docker run --rm --network none -i -v "$blob_volume:/data:ro" "$MOSAIC_UTILITY_IMAGE" sh -eu -c '
    checked=0
    while IFS="|" read -r storage_key expected_sha256 expected_size; do
      [ -n "$storage_key" ] || continue
      case "$storage_key" in
        /*|*".."*|*"\\"*|*"|"*) echo "unsafe storage key: $storage_key" >&2; exit 1 ;;
      esac
      case "$expected_sha256" in
        ""|*[!0-9a-f]*) echo "invalid active shard hash inventory: $storage_key" >&2; exit 1 ;;
      esac
      case "$expected_size" in
        ""|*[!0-9]*) echo "invalid active shard size inventory: $storage_key" >&2; exit 1 ;;
      esac
      blob_path="/data/$storage_key"
      [ -f "$blob_path" ] || { echo "missing active shard blob: $storage_key" >&2; exit 1; }
      actual_size="$(wc -c < "$blob_path" | tr -d " ")"
      [ "$actual_size" = "$expected_size" ] || { echo "active shard size mismatch: $storage_key" >&2; exit 1; }
      actual_sha256="$(sha256sum "$blob_path" | awk "{print \$1}")"
      [ "$actual_sha256" = "$expected_sha256" ] || { echo "active shard hash mismatch: $storage_key" >&2; exit 1; }
      checked=$((checked + 1))
    done
    echo "Verified $checked active shard blob(s) against database inventory"
  '
}

active_inventory_query() {
  printf "%s" "SELECT storage_key, lower(sha256), size_bytes FROM shards WHERE status = 'ACTIVE' ORDER BY storage_key;"
}

verify_live() {
  step "Reconciling active production shard rows against the blob volume"
  docker compose exec -T postgres psql -At -F '|' -U mosaic -d mosaic -c "$(active_inventory_query)" |
    verify_inventory_stream "mosaic_blob_data"
}

verify_isolated_backup() {
  local verify_id postgres_container blob_volume postgres_ready=false
  verify_id="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
  postgres_container="mosaic-backup-verify-$verify_id"
  blob_volume="mosaic_backup_verify_$verify_id"

  cleanup() {
    docker rm -f "$postgres_container" > /dev/null 2>&1 || true
    docker volume rm "$blob_volume" > /dev/null 2>&1 || true
  }
  trap cleanup EXIT

  step "Creating isolated verification volume"
  docker volume create "$blob_volume" > /dev/null
  step "Starting isolated PostgreSQL verifier"
  docker run -d --rm --network none --name "$postgres_container" \
    -e POSTGRES_DB=mosaic_verify \
    -e POSTGRES_USER=mosaic \
    -e POSTGRES_PASSWORD=mosaic_backup_verifier \
    -v "$BACKUP_DIR:/backup:ro" "$MOSAIC_UTILITY_IMAGE" > /dev/null

  for _ in $(seq 1 30); do
    if docker exec "$postgres_container" pg_isready -q -U mosaic -d mosaic_verify; then
      postgres_ready=true
      break
    fi
    sleep 1
  done
  [ "$postgres_ready" = true ] || fail "Isolated PostgreSQL verifier did not become ready"

  step "Restoring database archive into isolation"
  docker exec "$postgres_container" pg_restore --clean --if-exists --no-owner --no-privileges \
    -U mosaic -d mosaic_verify /backup/database.dump
  step "Extracting paired blob archive into isolation"
  docker run --rm --network none -v "$blob_volume:/data" -v "$BACKUP_DIR:/backup:ro" \
    "$MOSAIC_UTILITY_IMAGE" tar xzf /backup/blobs.tar.gz -C /data
  step "Comparing every active DB shard with its isolated blob"
  docker exec "$postgres_container" psql -At -F '|' -U mosaic -d mosaic_verify \
    -c "$(active_inventory_query)" | verify_inventory_stream "$blob_volume"
  done_message "Isolated backup restore and active-shard reconciliation passed"
  cleanup
  trap - EXIT
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/verify-backup.sh <backup-dir>
  ./scripts/verify-backup.sh --verify-live

Directory mode is non-destructive: it restores the paired archive into
temporary, network-isolated Docker resources and validates every active
shard's hash and length. --verify-live validates the current Compose
PostgreSQL/blob pair; run it only while the backend is quiesced.
EOF
}

command="${1:-}"
case "$command" in
  --verify-live)
    [ "$#" -eq 1 ] || fail "--verify-live accepts no additional arguments"
    require_docker
    verify_live
    ;;
  -h|--help|"")
    [ "$#" -le 1 ] || fail "Help accepts no additional arguments"
    usage
    ;;
  *)
    [ "$#" -eq 1 ] || fail "Directory mode accepts exactly one backup directory"
    require_docker
    BACKUP_DIR="$command"
    [ -d "$BACKUP_DIR" ] || fail "Backup directory not found: $BACKUP_DIR"
    BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
    [ -f "$BACKUP_DIR/database.dump" ] && [ -f "$BACKUP_DIR/blobs.tar.gz" ] && [ -f "$BACKUP_DIR/manifest.sha256" ] ||
      fail "Backup must contain database.dump, blobs.tar.gz, and manifest.sha256"
    verify_pair_manifest || fail "Backup manifest does not exactly match its database/blob pair"
    validate_blob_archive || fail "Blob archive is unreadable or contains unsafe members"
    verify_isolated_backup
    ;;
esac
