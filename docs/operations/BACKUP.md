# Backup Scheduler Templates

> **v1.0.x s44-y4** — Operator guidance for scheduling routine backups
> of a self-hosted Mosaic instance. Pairs with the skew-constraint
> contract in [`docs/RELEASE.md`](../RELEASE.md#backup-consistency-constraint-operators)
> (v1.0.x s44-y3).

Mosaic stores user content as **encrypted blobs only** — the server
never holds plaintext photos or metadata. Backups therefore protect
*availability*, not *confidentiality*: a stolen backup is no more
useful to an attacker than a stolen production volume. The only
operational risk is the database/blob skew problem described in
RELEASE.md; the templates in this document are designed to avoid it.

## Recommended cadence

| Tier | Frequency | Retention | Storage class |
|------|-----------|-----------|---------------|
| **Daily** | 03:00 local, every day | 14 daily archives | Hot (S3 Standard, B2 Hot, local NAS) |
| **Weekly** | Sunday 03:00 local | 8 weekly archives (≈ 2 months) | Warm (S3 IA, B2 Hot, off-site NAS) |
| **Monthly** | 1st of month 03:00 local | 12 monthly archives (≈ 1 year) | Cold (S3 Glacier, B2 Archive, offline) |

03:00 is recommended because it is far enough from typical upload
windows that the brief quiesce window in the template script is
unnoticeable. Adjust to your timezone.

Every archive is a **pair**: one Postgres dump and one `data/blobs/`
snapshot, captured back-to-back inside a single backend quiesce window.
Pairs MUST be retained and restored together — never restore the DB
half of one archive against the blob half of another (this is exactly
the skew failure mode documented in
[`RELEASE.md`](../RELEASE.md#the-skew-failure-mode)).

## Scheduling with systemd timers (preferred on modern Linux)

systemd timers are preferred over cron because they survive reboots,
log to the journal, support `Persistent=true` (catch-up runs if the
host was off at the scheduled time), and integrate with `systemctl
status` for observability.

### `/etc/systemd/system/mosaic-backup.service`

```ini
[Unit]
Description=Mosaic encrypted backup (Postgres + data/blobs paired snapshot)
Wants=network-online.target
After=network-online.target docker.service postgresql.service
# Do not start a backup while another is still running.
ConditionPathExists=/usr/local/bin/mosaic-backup.sh

[Service]
Type=oneshot
User=mosaic-backup
Group=mosaic-backup
# Tighten the runtime; the script needs read access to the data dir
# and write access to the staging dir only.
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/var/lib/mosaic-backup
ReadOnlyPaths=/var/lib/mosaic/blobs
# Pull credentials from an EnvironmentFile mode 0600 owned by the
# mosaic-backup user. Never inline secrets here.
EnvironmentFile=/etc/mosaic/backup.env
ExecStart=/usr/local/bin/mosaic-backup.sh daily

[Install]
WantedBy=multi-user.target
```

### `/etc/systemd/system/mosaic-backup.timer`

```ini
[Unit]
Description=Run mosaic-backup.service daily at 03:00

[Timer]
OnCalendar=*-*-* 03:00:00
# If the host was off at 03:00, run as soon as it comes back up.
Persistent=true
# Random jitter so co-tenant hosts do not all hammer S3 at once.
RandomizedDelaySec=10min
Unit=mosaic-backup.service

[Install]
WantedBy=timers.target
```

Enable with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mosaic-backup.timer
systemctl list-timers mosaic-backup.timer
```

For the weekly and monthly tiers, drop in
`mosaic-backup-weekly.{service,timer}` and
`mosaic-backup-monthly.{service,timer}` with `OnCalendar=Sun 03:00:00`
and `OnCalendar=*-*-01 03:00:00` respectively, and pass `weekly` /
`monthly` as the `ExecStart` argument. The script branches on that
argument to choose the retention bucket.

## Scheduling with cron (fallback)

If systemd is unavailable, the same script runs cleanly from cron.
Install a crontab for the `mosaic-backup` user:

```cron
# /etc/cron.d/mosaic-backup
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=ops@example.com

# Daily backup at 03:00 local time
0 3 * * *      mosaic-backup /usr/local/bin/mosaic-backup.sh daily

# Weekly backup on Sundays at 03:30 local time (offset from daily to
# avoid both running simultaneously on Sundays)
30 3 * * 0     mosaic-backup /usr/local/bin/mosaic-backup.sh weekly

# Monthly backup on the 1st at 04:00 local time
0 4 1 * *      mosaic-backup /usr/local/bin/mosaic-backup.sh monthly
```

Cron does not have `Persistent=true`; if the host is off at 03:00 the
job is simply skipped. If that matters, prefer systemd.

## The backup script

The script captures Postgres and `data/blobs/` inside a single backend
quiesce window so the skew constraint cannot be violated.

### `/usr/local/bin/mosaic-backup.sh`

```bash
#!/usr/bin/env bash
# Mosaic paired backup: Postgres + data/blobs.
# v1.0.x s44-y4. Pairs with v1.0.x s44-y3 (skew constraint).
#
# CONTRACT:
#   The Postgres dump and the data/blobs snapshot in any single
#   invocation form ONE archive pair. They MUST be restored together.
#   See docs/RELEASE.md "Backup Consistency Constraint" for why.
#
# Usage: mosaic-backup.sh {daily|weekly|monthly}
set -euo pipefail

TIER="${1:-daily}"
case "$TIER" in
    daily|weekly|monthly) ;;
    *) echo "usage: $0 {daily|weekly|monthly}" >&2; exit 2 ;;
esac

# --- Configuration (override via /etc/mosaic/backup.env) ---------------
: "${MOSAIC_DATA_DIR:=/var/lib/mosaic}"               # contains blobs/
: "${MOSAIC_BACKUP_STAGING:=/var/lib/mosaic-backup}"   # local staging
: "${MOSAIC_BACKUP_REMOTE:=s3://example-mosaic-backups}" # placeholder: S3/B2/etc.
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=mosaic}"
: "${PGDATABASE:=mosaic}"
# PGPASSWORD MUST come from the EnvironmentFile, never inline here.

TS="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_DIR="${MOSAIC_BACKUP_STAGING}/${TIER}/${TS}"
mkdir -p "$ARCHIVE_DIR"

log() { printf '[mosaic-backup %s] %s\n' "$(date -Is)" "$*"; }

# --- Step 1: quiesce the backend ---------------------------------------
# Brief maintenance window so the Postgres dump and the blob snapshot
# observe the same logical instant. The systemd unit for the backend
# is expected to support `mosaic-backend-maintenance.target`; if your
# deployment uses Docker Compose, swap to `docker compose pause`.
log "quiescing backend"
systemctl start mosaic-backend-maintenance.target

cleanup_quiesce() {
    log "resuming backend"
    systemctl stop mosaic-backend-maintenance.target || true
}
trap cleanup_quiesce EXIT

# --- Step 2: snapshot Postgres -----------------------------------------
# pg_dump --format=custom produces a single-file archive that supports
# parallel restore. For very large databases prefer pg_basebackup +
# continuous WAL archival; the trade-off is restore complexity vs
# backup speed.
log "dumping Postgres -> ${ARCHIVE_DIR}/postgres.dump"
pg_dump \
    --host="$PGHOST" --port="$PGPORT" \
    --username="$PGUSER" --dbname="$PGDATABASE" \
    --format=custom --compress=9 --no-owner --no-privileges \
    --file="${ARCHIVE_DIR}/postgres.dump"

# --- Step 3: snapshot data/blobs/ --------------------------------------
# rsync with --link-dest gives space-efficient incremental archives:
# unchanged shards are hard-linked from the previous archive.
# borg is an alternative with built-in deduplication + encryption at
# rest; uncomment the borg block if you prefer it.
log "snapshotting blobs -> ${ARCHIVE_DIR}/blobs/"
PREV_LINK_DEST=""
PREV="$(find "${MOSAIC_BACKUP_STAGING}/${TIER}" -maxdepth 1 -mindepth 1 \
    -type d ! -path "$ARCHIVE_DIR" | sort | tail -n1 || true)"
if [[ -n "$PREV" && -d "${PREV}/blobs" ]]; then
    PREV_LINK_DEST="--link-dest=${PREV}/blobs"
fi
# shellcheck disable=SC2086
rsync -aHAX --numeric-ids ${PREV_LINK_DEST} \
    "${MOSAIC_DATA_DIR}/blobs/" "${ARCHIVE_DIR}/blobs/"

# Alternative: borg-based snapshot (deduplicated, encrypted at rest).
# Uncomment if you prefer borg over rsync. Requires `borg init` once.
#
# borg create \
#     --stats --compression zstd,6 \
#     "${MOSAIC_BORG_REPO}::mosaic-${TIER}-${TS}" \
#     "${MOSAIC_DATA_DIR}/blobs"

# --- Step 4: resume the backend ----------------------------------------
# Resume as early as possible — the upload to remote storage and the
# integrity check do not need the backend to be quiesced.
cleanup_quiesce
trap - EXIT

# --- Step 5: write a manifest ------------------------------------------
# The manifest pins the two halves together. A restore script MUST
# refuse to use a postgres.dump unless the manifest matches the blobs/
# tree it is paired with.
cat > "${ARCHIVE_DIR}/manifest.json" <<EOF
{
  "schema": 1,
  "tier": "${TIER}",
  "captured_at_utc": "${TS}",
  "postgres_dump": "postgres.dump",
  "postgres_dump_sha256": "$(sha256sum "${ARCHIVE_DIR}/postgres.dump" | cut -d' ' -f1)",
  "blobs_dir": "blobs",
  "blobs_file_count": $(find "${ARCHIVE_DIR}/blobs" -type f | wc -l),
  "blobs_total_bytes": $(du -sb "${ARCHIVE_DIR}/blobs" | cut -f1),
  "skew_contract": "docs/RELEASE.md#backup-consistency-constraint-operators"
}
EOF

# --- Step 6: integrity check -------------------------------------------
# Verify the dump is restorable by parsing its TOC. This catches
# truncated dumps and corrupted custom-format archives.
log "verifying Postgres dump"
pg_restore --list "${ARCHIVE_DIR}/postgres.dump" > /dev/null

# Spot-check a random subset of blobs against their source. The shard
# files are content-addressed elsewhere; here we just confirm rsync
# delivered them byte-for-byte.
log "verifying blob sample"
SAMPLE_COUNT=20
mapfile -t SAMPLE < <(find "${ARCHIVE_DIR}/blobs" -type f | shuf -n "$SAMPLE_COUNT")
for f in "${SAMPLE[@]}"; do
    rel="${f#${ARCHIVE_DIR}/blobs/}"
    src="${MOSAIC_DATA_DIR}/blobs/${rel}"
    if ! cmp -s "$f" "$src"; then
        echo "::error::blob mismatch: $rel" >&2
        exit 1
    fi
done

# --- Step 7: upload to remote ------------------------------------------
# Placeholder: replace with the operator's preferred remote.
# Examples are commented out — uncomment exactly one.
log "uploading archive to ${MOSAIC_BACKUP_REMOTE}"

# AWS S3
# aws s3 sync "${ARCHIVE_DIR}" "${MOSAIC_BACKUP_REMOTE}/${TIER}/${TS}/" \
#     --storage-class STANDARD_IA --only-show-errors

# Backblaze B2
# b2 sync "${ARCHIVE_DIR}" "${MOSAIC_BACKUP_REMOTE}/${TIER}/${TS}/"

# rclone (S3-compatible, SFTP, etc.)
# rclone sync "${ARCHIVE_DIR}" "${MOSAIC_BACKUP_REMOTE}/${TIER}/${TS}/" \
#     --transfers=8 --checkers=16

# --- Step 8: enforce retention -----------------------------------------
case "$TIER" in
    daily)   KEEP=14 ;;
    weekly)  KEEP=8 ;;
    monthly) KEEP=12 ;;
esac
log "pruning ${TIER} archives older than the most recent ${KEEP}"
find "${MOSAIC_BACKUP_STAGING}/${TIER}" -maxdepth 1 -mindepth 1 \
    -type d | sort | head -n "-${KEEP}" | xargs -r rm -rf

log "backup complete: ${ARCHIVE_DIR}"
```

### `/etc/mosaic/backup.env`

```bash
# Mode 0600, owned by mosaic-backup:mosaic-backup
PGPASSWORD=replace-with-the-mosaic-db-password
MOSAIC_BACKUP_REMOTE=s3://your-bucket-name
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# AWS_REGION=us-east-1
```

## Integrity verification cadence

The script verifies every archive at capture time (`pg_restore --list`
plus a blob sample). In addition, run a **full restore drill at least
once per month** into a disposable environment:

1. Stand up an empty Postgres + empty `data/blobs/` on a scratch host.
2. Restore the *paired* archive (same `${TS}` for both halves).
3. Boot the backend pointed at the scratch volumes.
4. Run the standard E2E smoke suite against it.

If the drill fails, the most common cause is a paired-archive mismatch
introduced by an operator restoring halves from different `${TS}`
buckets — exactly the failure mode the manifest file is designed to
catch. The recovery procedure for a skewed restore is documented in
[`docs/RELEASE.md`](../RELEASE.md#recovery-dangling-manifest-entries-after-a-skewed-restore).

## Related references

- [`docs/RELEASE.md`](../RELEASE.md#backup-consistency-constraint-operators)
  — Backup consistency contract (v1.0.x s44-y3). Required reading
  before deploying these templates.
- [`docs/SECURITY.md`](../SECURITY.md) — Zero-knowledge invariants.
  Backups inherit the same properties: blobs are encrypted at rest by
  the application before they ever reach `data/blobs/`.
