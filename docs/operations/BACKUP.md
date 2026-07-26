# Backup Scheduler Templates

> **Status:** Current scheduling guidance for customized and supplied
> self-hosted deployments. Last reviewed 2026-07-26. Pairs with the
> skew-constraint contract in
> [`docs/RELEASE.md`](../RELEASE.md#backup-consistency-constraint-operators).
> See [RELEASE_STATE.md](../RELEASE_STATE.md) for product maturity.

Mosaic stores user content as **encrypted blobs only** — the server
never holds plaintext photos or metadata. Backups therefore protect
*availability*, not *confidentiality*: a stolen backup is no more
useful to an attacker than a stolen production volume. The principal content-consistency risk addressed here is the database/blob
skew problem described in RELEASE.md; the supplied helpers are designed to
avoid it.

## Supplied Docker Compose procedure

For the Compose deployment shipped in this repository, use the canonical helper commands directly:

```bash
./scripts/mosaic.sh backup
./scripts/mosaic.sh verify-backup backups/<timestamp>
./scripts/mosaic.sh restore backups/<timestamp>
```

On Windows, the equivalent commands are `./scripts/mosaic.ps1 backup`,
`./scripts/mosaic.ps1 verify-backup backups\<timestamp>`, and
`./scripts/mosaic.ps1 restore backups\<timestamp>`.

Both helpers enforce the same recovery contract:

1. Stop a running backend while the custom Postgres dump and blob archive are
   captured, then hash-bind those exact files in a manifest.
2. Reject unreadable archives, absolute/traversing member paths, and archive
   links or special files before extraction.
3. Restore each new backup into temporary network-isolated Postgres and blob
   resources and compare every `ACTIVE` shard's file length and SHA-256 with
   the restored database inventory. `verify-backup` can repeat this drill at
   any time without modifying the live deployment.
4. Rehearse the same isolated restore before a destructive live restore, then
   repeat active-shard reconciliation against the live volume before reporting
   success. A failed restore leaves a previously running backend stopped.

The server never has client decryption keys, so DB/blob integrity verification
cannot prove that operators still possess usable client key material. Complete
each monthly disaster-recovery drill by signing in from a fresh supported web
client and decrypting a designated, retained test album. Record the backup ID,
release digest, active-shard count, client version, result, RPO, and RTO in the
operator's incident/change system. Do not treat a storage-only check as a
complete disaster-recovery drill.

## Recommended cadence

| Tier | Frequency | Retention | Storage class |
|------|-----------|-----------|---------------|
| **Daily** | 03:00 local, every day | 14 daily archives | Hot (S3 Standard, B2 Hot, local NAS) |
| **Weekly** | Sunday 03:00 local | 8 weekly archives (≈ 2 months) | Warm (S3 IA, B2 Hot, off-site NAS) |
| **Monthly** | 1st of month 03:00 local | 12 monthly archives (≈ 1 year) | Cold (S3 Glacier, B2 Archive, offline) |

03:00 is recommended because it is far enough from typical upload
windows that the brief quiesce window in the canonical helper is
unnoticeable. Adjust to your timezone.

Every archive is a **pair**: one Postgres dump and one `data/blobs/`
snapshot, captured back-to-back inside a single backend quiesce window.
Pairs MUST be retained and restored together — never restore the DB
half of one archive against the blob half of another (this is exactly
the skew failure mode documented in
[`RELEASE.md`](../RELEASE.md#the-skew-failure-mode)).

## Scheduling the supplied helper

There is one supported backup implementation: the repository helper above.
Schedulers must invoke it directly; do not copy its logic into a second script,
replace the maintenance lock, or substitute `docker compose pause` for the
backend stop boundary.

For systemd, install the checkout at a fixed path and run the service as the
trusted deployment operator that already has permission to use Docker. Docker
socket access is effectively root-equivalent, so do not grant it to a separate
low-trust backup account.

```ini
# /etc/systemd/system/mosaic-backup.service
[Unit]
Description=Mosaic verified paired backup
Requires=docker.service
After=docker.service
ConditionPathExists=/opt/mosaic/scripts/mosaic.sh

[Service]
Type=oneshot
User=mosaic-operator
Group=mosaic-operator
WorkingDirectory=/opt/mosaic
ExecStart=/opt/mosaic/scripts/mosaic.sh backup
NoNewPrivileges=true

# /etc/systemd/system/mosaic-backup.timer
[Unit]
Description=Run the Mosaic paired backup daily

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=10min
Unit=mosaic-backup.service

[Install]
WantedBy=timers.target
```

Enable and inspect it with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mosaic-backup.timer
systemctl list-timers mosaic-backup.timer
journalctl -u mosaic-backup.service
```

A cron installation follows the same rule and invokes the canonical helper,
not a forked implementation:

```cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=ops@example.com
0 3 * * * mosaic-operator cd /opt/mosaic && ./scripts/mosaic.sh backup
```

The helper writes one verified `backups/<timestamp>/` directory. After it exits
successfully, copy that complete directory to encrypted off-host storage. Never
sync the three files independently, regenerate `manifest.sha256`, or prune the
last known-good recovery point until the copied directory has passed
`./scripts/mosaic.sh verify-backup <copied-directory>`. Transport and retention
commands are operator-specific and intentionally outside the consistency tool;
they do not replace its quiesce, manifest, isolated restore, or reconciliation
checks.

## Custom non-Compose deployments

The supplied helper and its architecture gates cover the shipped Compose
volumes and service names only. A systemd-native, Kubernetes, S3-backed, or
storage-snapshot deployment needs its own reviewed quiesce and restore tool,
continuous-mutation acceptance test, and dated restore-drill evidence. This
repository does not publish a generic alternate script or claim that an
illustrative maintenance target is equivalent to the Compose contract.

## Related references

- [`docs/RELEASE.md`](../RELEASE.md#backup-consistency-constraint-operators)
  — Backup consistency contract. Required reading
  before deploying these templates.
- [`docs/SECURITY.md`](../SECURITY.md) — Zero-knowledge invariants.
  Backups inherit the same properties: blobs are encrypted at rest by
  the application before they ever reach `data/blobs/`.
