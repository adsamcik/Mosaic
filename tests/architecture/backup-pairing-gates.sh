#!/usr/bin/env bash
# Compose backup/restore must use one quiesced, hash-bound, rehearsed DB/blob pair.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$PROJECT_ROOT"

python3 - <<'PY'
from pathlib import Path
import re

bash = Path("scripts/mosaic.sh").read_text(encoding="utf-8")
powershell = Path("scripts/mosaic.ps1").read_text(encoding="utf-8")
verifier = Path("scripts/verify-backup.sh").read_text(encoding="utf-8")
compose = Path("docker-compose.yml").read_text(encoding="utf-8")

image_match = re.search(
    r"^\s*image:\s+(postgres:17-alpine@sha256:[0-9a-f]{64})\s*$", compose, re.MULTILINE
)
if image_match is None:
    raise SystemExit("backup-pairing-gates: production PostgreSQL image is not immutable")
utility_image = image_match.group(1)
for label, text, declaration in (
    ("Bash operator", bash, f'MOSAIC_UTILITY_IMAGE="{utility_image}"'),
    ("Bash verifier", verifier, f'MOSAIC_UTILITY_IMAGE="{utility_image}"'),
    ("PowerShell operator", powershell, f'$MosaicUtilityImage = "{utility_image}"'),
):
    if declaration not in text:
        raise SystemExit(f"backup-pairing-gates: {label} helper image does not match Compose")
    if re.search(r"\bpostgres:17-alpine(?!@sha256)", text) or re.search(r"docker run[^\n]*\salpine(?:\s|$)", text):
        raise SystemExit(f"backup-pairing-gates: {label} uses a floating helper image")


requirements = (
    ("Bash backend quiesce", bash, "docker compose stop backend"),
    ("Bash custom database dump", bash, "pg_dump --format=custom"),
    ("Bash paired manifest", bash, "write_backup_manifest"),
    ("Bash canonical manifest file", bash, "manifest.sha256"),
    ("Bash canonical manifest writer", bash, r'printf "%s  database.dump\n%s  blobs.tar.gz\n"'),
    ("Bash exact restore arguments", bash, 'if [ "$#" -ne 1 ]; then'),
    ("Bash clean database replacement", bash, "dropdb --if-exists --force"),
    ("Bash recreate database", bash, "createdb -U mosaic -O mosaic mosaic"),
    ("Bash restore manifest verification", bash, "verify_backup_manifest"),
    ("Bash exclusive maintenance lock", bash, "acquire_maintenance_lock"),
    ("Bash stopped-container resume", bash, "docker compose start backend"),
    ("Bash backend health wait", bash, "wait_backend_healthy"),
    ("Bash no-reconcile resume helper", bash, "resume_backend_without_reconcile"),
    ("Bash isolated backup rehearsal", bash, '"$SCRIPT_DIR/verify-backup.sh" "$BACKUP_DIR"'),
    ("Bash live restore reconciliation", bash, '"$SCRIPT_DIR/verify-backup.sh" --verify-live'),
    ("Verifier network isolation", verifier, "--network none"),
    ("Verifier archive traversal rejection", verifier, "unsafe blob archive member"),
    ("Verifier archive link/special-file rejection", verifier, "unsafe non-file archive member"),
    ("Verifier clean isolated database restore", verifier, "pg_restore --clean --if-exists --no-owner --no-privileges"),
    ("Verifier active shard query", verifier, "FROM shards WHERE status = 'ACTIVE'"),
    ("Verifier missing blob rejection", verifier, "missing active shard blob"),
    ("Verifier blob size reconciliation", verifier, "active shard size mismatch"),
    ("Verifier blob hash reconciliation", verifier, "active shard hash mismatch"),
    ("PowerShell backend quiesce", powershell, "docker compose stop backend"),
    ("PowerShell canonical manifest file", powershell, "manifest.sha256"),
    ("PowerShell lowercase manifest hashes", powershell, ".Hash.ToLowerInvariant()"),
    ("PowerShell canonical manifest writer", powershell, '$manifestText = "$databaseHash  database.dump`n$blobHash  blobs.tar.gz`n"'),
    ("PowerShell exact manifest verification", powershell, "Backup manifest does not exactly match its database/blob pair; refusing restore"),
    ("PowerShell safe archive traversal gate", powershell, "unsafe blob archive member"),
    ("PowerShell safe archive type gate", powershell, "unsafe non-file archive member"),
    ("PowerShell network-isolated rehearsal", powershell, "Invoke-MosaicIsolatedBackupVerification"),
    ("PowerShell clean database replacement", powershell, "dropdb --if-exists --force"),
    ("PowerShell recreate database", powershell, "createdb -U mosaic -O mosaic mosaic"),
    ("PowerShell clean isolated database restore", powershell, "pg_restore --clean --if-exists --no-owner --no-privileges"),
    ("PowerShell active shard query", powershell, "FROM shards WHERE status = 'ACTIVE'"),
    ("PowerShell missing blob rejection", powershell, "missing active shard blob"),
    ("PowerShell blob size reconciliation", powershell, "active shard size mismatch"),
    ("PowerShell blob hash reconciliation", powershell, "active shard hash mismatch"),
    ("PowerShell live restore reconciliation", powershell, "Invoke-MosaicLiveInventoryVerification"),
    ("PowerShell exclusive maintenance lock", powershell, "Enter-MosaicMaintenanceLock"),
    ("PowerShell lock file sharing", powershell, "[System.IO.FileShare]::None"),
    ("PowerShell UTC backup timestamp", powershell, 'ToUniversalTime().ToString("yyyyMMddTHHmmss.fffZ"'),
    ("PowerShell backup directory non-reuse", powershell, "Backup directory already exists"),
    ("PowerShell backend health wait", powershell, "Wait-MosaicBackendHealthy"),
    ("PowerShell explicit backup verifier command", powershell, '"verify-backup" {'),
)
for label, text, token in requirements:
    if token not in text:
        raise SystemExit(f"backup-pairing-gates: missing {label}: {token}")

if "docker compose up -d --wait backend" in bash:
    raise SystemExit("backup-pairing-gates: Bash must resume the stopped backend without reconciling a candidate image")
if "manifest.json" in bash or "manifest.json" in powershell:
    raise SystemExit("backup-pairing-gates: Compose helpers must not emit the retired JSON manifest")
if bash.count("manifest.sha256") < 3 or powershell.count("manifest.sha256") < 3:
    raise SystemExit("backup-pairing-gates: both helpers must create and verify the canonical manifest")


def section(text: str, start: str, end: str) -> str:
    begin = text.index(start)
    return text[begin:text.index(end, begin)]


bash_update = section(bash, "    update)\n", "    backup)\n")
bash_backup = section(bash, "    backup)\n", "    restore)\n")
bash_restore = section(bash, "    restore)\n", "    verify-backup)\n")
ps_update = section(powershell, '        "update" {', '        "backup" {')
ps_backup = section(powershell, '        "backup" {', '        "restore" {')
ps_restore = section(powershell, '        "restore" {', '        "verify-backup" {')


def assert_order(label: str, text: str, *tokens: str) -> None:
    cursor = -1
    for token in tokens:
        found = text.find(token, cursor + 1)
        if found < 0:
            raise SystemExit(f"backup-pairing-gates: {label} lacks ordered token: {token}")
        if found <= cursor:
            raise SystemExit(f"backup-pairing-gates: {label} ordering failed at: {token}")
        cursor = found


assert_order(
    "Bash update",
    bash_update,
    '"$SCRIPT_DIR/mosaic.sh" backup',
    "docker compose pull",
    "acquire_maintenance_lock || exit 1",
    "UPDATE_QUIESCED=true",
    "docker compose stop backend",
    "docker compose run --rm --no-deps backend --migrate-only",
    "docker compose up -d --remove-orphans --wait",
    "UPDATE_COMPLETE=true",
)
if "trap cleanup_update EXIT" not in bash_update or "docker compose stop frontend backend" not in bash_update:
    raise SystemExit("backup-pairing-gates: Bash update is not fail-closed after quiesce")

assert_order(
    "PowerShell update",
    ps_update,
    "& $PSCommandPath backup",
    "docker compose pull",
    "$maintenanceLock = Enter-MosaicMaintenanceLock",
    "$deploymentQuiesced = $true",
    "docker compose stop backend",
    "docker compose run --rm --no-deps backend --migrate-only",
    "docker compose up -d --remove-orphans --wait",
    "$updateComplete = $true",
)
if "finally" not in ps_update or "docker compose stop frontend backend" not in ps_update:
    raise SystemExit("backup-pairing-gates: PowerShell update is not fail-closed after quiesce")

assert_order(
    "Bash backup",
    bash_backup,
    "acquire_maintenance_lock || exit 1",
    "docker compose ps --status running -q backend",
    "docker compose stop backend",
    "pg_dump --format=custom",
    "tar czf /backup/blobs.tar.gz",
    "write_backup_manifest",
    '"$SCRIPT_DIR/verify-backup.sh" "$BACKUP_DIR"',
    "Matched backup pair saved",
)
assert_order(
    "Bash restore",
    bash_restore,
    "verify_backup_manifest",
    '"$SCRIPT_DIR/verify-backup.sh" "$BACKUP_DIR"',
    "verify_backup_manifest",
    "docker compose stop backend",
    "dropdb --if-exists --force",
    "createdb -U mosaic -O mosaic mosaic",
    "pg_restore --clean --if-exists",
    "tar xzf /backup/blobs.tar.gz",
    '"$SCRIPT_DIR/verify-backup.sh" --verify-live',
    "RESTORE_COMPLETE=true",
    "resume_backend_without_reconcile",
    "Verified restore complete",
)
assert_order(
    "PowerShell backup",
    ps_backup,
    "$maintenanceLock = Enter-MosaicMaintenanceLock",
    "docker compose ps --status running -q backend",
    "docker compose stop backend",
    "pg_dump --format=custom",
    "tar czf /backup/blobs.tar.gz",
    '$manifestText = "$databaseHash  database.dump`n$blobHash  blobs.tar.gz`n"',
    "Wait-MosaicBackendHealthy",
    "Invoke-MosaicIsolatedBackupVerification",
    "Matched backup pair saved",
)
assert_order(
    "PowerShell restore",
    ps_restore,
    "Get-MosaicVerifiedBackup",
    "Invoke-MosaicIsolatedBackupVerification",
    "$maintenanceLock = Enter-MosaicMaintenanceLock",
    "Get-MosaicVerifiedBackup",
    "docker compose stop backend",
    "dropdb --if-exists --force",
    "createdb -U mosaic -O mosaic mosaic",
    "pg_restore --clean --if-exists",
    "tar xzf /backup/blobs.tar.gz",
    "Invoke-MosaicLiveInventoryVerification",
    "$restoreComplete = $true",
    "Wait-MosaicBackendHealthy",
    "Verified restore complete",
)

print("backup-pairing-gates: OK (cross-platform backups are quiesced, immutable-image rehearsed, cleanly replaced, and reconciled)")
PY
