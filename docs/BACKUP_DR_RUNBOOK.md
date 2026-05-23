# Mosaic — Backup & Disaster Recovery Runbook

> **Status:** Operator runbook. Last reviewed for v1.0.2.
> **Audience:** Self-hosting operators (≤50-user deployments).
> **Companion to:** `docs/DEPLOYMENT.md`, `docs/DOCKER.md`, `docs/SECURITY.md`.

This runbook documents the **operator-side** disaster recovery procedure for a
Mosaic deployment. The client-side recovery story (lost password, lost device)
is separate and is documented inline in the web app's recovery flow plus the
`SECURITY.md` §"Key Hierarchy" treatment.

Because Mosaic is **zero-knowledge**, the operator's recovery scope is
narrower than a typical photo-server's. The operator restores the
**encrypted-at-rest substrate** (PostgreSQL database + blob storage); the
client materialises the plaintext gallery from its own keys on next login.
The operator never needs (and cannot acquire) plaintext keys to perform DR.

## What needs to be backed up

| Component | What | Where (default Docker compose layout) | Plaintext-sensitive? |
|---|---|---|---|
| **PostgreSQL** | All Mosaic tables (users, albums, members, manifests, epoch_keys, share_links, sidecar telemetry counters) | `mosaic_postgres_data` volume | No — all user content is encrypted; the operator-visible metadata (account ids, album ids, sizes, timestamps) is operational and already exposed to the operator at runtime. |
| **Blob storage** | Per-shard encrypted blobs (one file per shard id) | `mosaic_blobs` volume (or S3-compatible bucket if configured) | No — every byte is `SGzk`-envelope ciphertext (ADR-013, ADR-022). |
| **Reverse-proxy configuration** | NGINX / Caddy site config including COOP/COEP headers, TLS cert chain, Authelia config | Operator-managed (outside the compose stack) | TLS private key is sensitive; COOP/COEP config is public. |
| **Compose / orchestrator state** | `docker-compose.yml`, `.env`, container image digests | Operator-managed | The `.env` contains the DB password and trusted-proxy header secrets — sensitive. |
| **What is NOT backed up** | No plaintext keys, no plaintext photos, no decryption material. The server has none. | n/a | n/a — by design. |

## Backup procedure

The recommended cadence for a ≤50-user deployment is **daily incremental,
weekly full**, with a 28-day retention.

### 1. PostgreSQL

Use the standard `pg_dump` flow against the running database container:

```powershell
# Windows / PowerShell example
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
docker compose exec -T postgres pg_dump -U mosaic -F c -d mosaic |
    Out-File -FilePath "C:\mosaic-backups\db-$ts.pgdump" -Encoding byte
```

```bash
# Linux / shell example
ts=$(date -u +%Y%m%d-%H%M%S)
docker compose exec -T postgres pg_dump -U mosaic -F c -d mosaic > /var/backups/mosaic/db-$ts.pgdump
```

The `-F c` (custom format) dump is required for the restore procedure below
and supports parallel restore. Retain ≥ 28 days; older dumps move to
cold storage if regulatory retention requires it.

### 2. Blob storage

Blobs are append-only and content-addressed at the application layer (per
ADR-022 + ADR-027), so a simple `rsync`-style snapshot is sufficient:

```bash
rsync -a --delete /var/lib/docker/volumes/mosaic_blobs/_data/ /var/backups/mosaic/blobs/
```

If the deployment uses an S3-compatible bucket, enable bucket-level
versioning and lifecycle rules instead — that fulfils the same role with
better atomicity.

### 3. Reverse-proxy + compose state

```bash
tar czf /var/backups/mosaic/config-$(date -u +%Y%m%d).tgz \
    /etc/nginx/sites-available/mosaic \
    /etc/authelia \
    /opt/mosaic/docker-compose.yml \
    /opt/mosaic/.env
```

Encrypt this archive at rest (`age`, `gpg`, or backup-tool-native): it
contains the DB password and the trusted-proxy header secret.

### Verification (DO NOT SKIP)

A backup that has never been restored is not a backup. Once per quarter:

1. Spin up a scratch host (or `docker compose` namespace).
2. Restore the latest full backup using the restore procedure below.
3. Boot the stack against an empty client-side state and confirm a known
   test user can log in (Authelia / reverse-proxy auth completes) and
   the album list endpoint returns the expected count of encrypted
   manifests.
4. Tear down. Record the verification in the operator log.

## Restore procedure (RPO/RTO targets: 24 h RPO, 4 h RTO)

### 0. Pre-flight

- Confirm the new host has the same OS major / `docker engine` major as
  the source host.
- Confirm the toolchain versions match the pinned values in
  `docs/TOOLCHAIN_LIFECYCLE.md` for the release you are restoring.
- Confirm you have all three artifact classes: DB dump, blob snapshot,
  config archive. Missing any one means partial restore — see "Partial
  recovery" below.

### 1. Bring up infrastructure shell

Restore the compose / config archive first:

```bash
tar xzf /var/backups/mosaic/config-YYYYMMDD.tgz -C /
```

Edit `.env` to point at the new host's networking / TLS cert paths if
they changed.

### 2. Start PostgreSQL only

```bash
docker compose up -d postgres
# wait for the container to become healthy
docker compose exec postgres pg_isready -U mosaic
```

### 3. Restore the database

```bash
docker compose exec -T postgres dropdb -U mosaic --if-exists mosaic
docker compose exec -T postgres createdb -U mosaic mosaic
docker compose exec -T postgres pg_restore -U mosaic -d mosaic --no-owner --clean --if-exists \
    < /var/backups/mosaic/db-YYYYMMDD-HHMMSS.pgdump
```

Run the schema-integrity check:

```bash
docker compose exec postgres psql -U mosaic -d mosaic -c "SELECT COUNT(*) FROM users;"
docker compose exec postgres psql -U mosaic -d mosaic -c "SELECT COUNT(*) FROM albums;"
docker compose exec postgres psql -U mosaic -d mosaic -c "SELECT COUNT(*) FROM manifests;"
```

The counts should match what the source host reported at the time of the
backup. A mismatch indicates the dump is corrupt — go to a previous
backup.

### 4. Restore blob storage

```bash
rsync -a --delete /var/backups/mosaic/blobs/ /var/lib/docker/volumes/mosaic_blobs/_data/
```

Set ownership / SELinux labels to match what the backend container
expects (typically uid `1000`). The deployment doc has the host-specific
table.

### 5. Bring up the rest of the stack

```bash
docker compose up -d
```

Confirm health endpoints:

```bash
curl -fsS http://localhost:5000/health
```

### 6. Smoke test from a known client

From a browser that already holds a valid session token from the source
host (or a fresh login through Authelia):

- Album list loads with the expected number of albums.
- Selecting an album streams shards and the client successfully decrypts
  them (proves blob storage is bit-identical to the source).
- A new upload completes through TUS resumable upload and the new shard
  is visible after a refresh.

If any of these fail, **do not destroy the source host** until the
failure is understood. A partial restore can be reverted by pointing
the reverse proxy back at the source.

## Partial recovery

| Lost artefact | Recoverable? | Outcome |
|---|---|---|
| Only DB | **No.** Without blobs, manifests reference shard ids that resolve nowhere. | Users see albums with broken shard fetches. Restore an older snapshot that has matching blobs, or accept data loss for newly-uploaded shards since the last blob snapshot. |
| Only blobs | **No.** Without the manifests table the shards are unaddressable. | Resolved opaque blobs cannot be reconstructed into albums. Restore an older DB snapshot that references shards present in the blob snapshot. |
| Only config | **Yes — partial.** Reconstruct from `docs/DEPLOYMENT.md` defaults + the deployment's documented `.env` template. | Requires Authelia/reverse-proxy reconfiguration; the DB password must be re-set and the backend restarted with the new value. |
| Lost all three | **No.** | Total loss. Users must re-onboard from their client-side state if they have it (clients hold all keys; some clients hold full local OPFS caches that may be uploaded back, but this is a manual process). |

The asymmetric DB/blob dependency is intentional: the manifest is the
single source of truth that *binds* blobs into albums. Backing up only
one half is worse than useless — it gives a false sense of recoverability.

## What the operator cannot recover

- **User passwords.** Authelia (or the configured upstream IdP) owns
  authentication; password reset is an Authelia concern, not a Mosaic
  concern.
- **Client-side key material (L0/L1/L2).** Lost on the client = lost
  forever. The server stores only encrypted-at-rest L2 wraps, which are
  useless without the user's L0 (derived from password).
- **Plaintext photos.** The server has never had them.

## Tested boundaries

| Test | Frequency | Last verified |
|---|---|---|
| DB-only restore against scratch host | Quarterly | (operator log) |
| Full DR drill (DB + blobs + config) against scratch host | Quarterly | (operator log) |
| Backup encryption-at-rest spot check (random-sample read with the configured key) | Monthly | (operator log) |

Operators are expected to maintain an operator log with the last-verified
date for each row. A drill that has not happened in the last 6 months is
treated as a failed control.

## See also

- `docs/DEPLOYMENT.md` — install / upgrade
- `docs/DOCKER.md` — container specifics
- `docs/SECURITY.md` — threat model and key hierarchy
- `docs/AUTHELIA.md` — authentication operations
- `docs/TOOLCHAIN_LIFECYCLE.md` — supported runtime versions
- ADR-022 — manifest finalization (defines blob ↔ manifest binding)
