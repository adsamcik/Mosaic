# Mosaic — Backup & Disaster Recovery Runbook

> **Status:** Current operator procedure for the supplied Compose deployment.
> **Last reviewed:** 2026-07-26.
> **Release maturity:** See [RELEASE_STATE.md](RELEASE_STATE.md).
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
| **Blob storage** | Per-shard encrypted blobs (one file per shard id) | `mosaic_blob_data` volume | No — every byte is `SGzk`-envelope ciphertext (ADR-013, ADR-022). |
| **Audit logs** | Append-only operational audit sink | `mosaic_audit_data` volume | Potentially sensitive operational identifiers; retain and protect under the deployment audit policy. It is not part of the DB/blob consistency pair. |
| **Reverse-proxy configuration** | NGINX / Caddy site config including COOP/COEP headers, TLS cert chain, Authelia config | Operator-managed (outside the compose stack) | TLS private key is sensitive; COOP/COEP config is public. |
| **Compose / orchestrator state** | `docker-compose.yml`, `.env`, container image digests | Operator-managed | The `.env` contains the DB password and trusted-proxy header secrets — sensitive. |
| **What is NOT backed up** | No plaintext keys, no plaintext photos, no decryption material. The server has none. | n/a | n/a — by design. |

## Backup procedure

The recommended cadence for a small deployment is daily, with at least 28 days
of retained recovery points and one off-host copy. Each recovery point is one
indivisible, hash-bound database/blob directory.

### 1. Create the matched pair

Use the repository helper from the directory containing `docker-compose.yml`:

```bash
./scripts/mosaic.sh backup
```

```powershell
.\scripts\mosaic.ps1 backup
```

The command serializes maintenance operations, stops a running backend for the
capture, creates a custom PostgreSQL dump and blob archive, records their
SHA-256 hashes, resumes the backend, and rehearses the pair in isolated Docker
resources. Do not copy, expire, rename, or restore either file independently;
move the complete `backups/<timestamp>` directory as one unit.

If the capture or isolated rehearsal fails, that directory is not a valid
backup. Investigate it and create a new pair before pruning an older recovery
point.

### 2. Protect off-host state

Copy the complete verified backup directory to encrypted off-host storage.
Back up reverse-proxy configuration, TLS/identity-provider state,
`docker-compose.yml`, `.env`, exact image digests, and the `audit_data` volume
under the operator backup policy. Those operational artifacts can have their
own retention schedule, but they must identify which paired content backup and
release digest they accompany. Protect `.env`, TLS keys, and audit records as
sensitive data.

### 3. Verify and drill

Repeat the non-destructive isolated rehearsal whenever a retained copy is
moved or sampled:

```bash
./scripts/mosaic.sh verify-backup backups/<timestamp>
```

```powershell
.\scripts\mosaic.ps1 verify-backup backups\<timestamp>
```

At least monthly, restore a retained pair on a scratch deployment and use a
fresh supported web client to sign in and decrypt a designated test album.
Storage reconciliation cannot prove that usable client key material still
exists. Record the backup ID, release digest, active-shard count, client
version, result, RPO, and RTO in the operator log.

## Restore procedure (RPO/RTO objectives: 24 h RPO, 4 h RTO)

### 0. Pre-flight

- Keep the source deployment intact until the drill and client smoke test pass.
- Restore the configuration for the exact release digest being recovered, then
  adjust only host-specific network and TLS paths.
- Confirm the selected directory contains `database.dump`, `blobs.tar.gz`, and
  the canonical `manifest.sha256`. Bash and PowerShell use the same format;
  never assemble a pair from different
  timestamps.
- Start PostgreSQL if necessary; keep the serving backend stopped until the
  verified restore is complete.

### 1. Rehearse and restore the pair

Run only the canonical helper:

```bash
./scripts/mosaic.sh restore backups/<timestamp>
```

```powershell
.\scripts\mosaic.ps1 restore backups\<timestamp>
```

Before asking for destructive confirmation, the helper validates the manifest,
rejects unsafe archive members, restores into isolated resources, and compares
every active shard row with the restored file length and SHA-256. It then stops
the live backend, restores both halves, repeats the active-shard reconciliation
against the live volumes, and restarts a previously running backend only after
success. A failed restore leaves the backend stopped; do not bypass that
fail-closed state or run raw `pg_restore`, archive extraction, or volume-copy
commands against production.

### 2. Smoke test from a known client

From a fresh supported browser session through the configured authentication
boundary:

- Album list loads with the expected number of albums.
- The designated recovery album streams and decrypts successfully.
- A new upload completes through Tus and is visible after refresh.
- Audit output remains writable in the persistent audit volume.

If any check fails, keep the restored backend out of service and preserve the
source deployment and both backup copies for diagnosis.

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
| Isolated restore and full active-shard reconciliation of a matched pair | Every backup and before every live restore | (operator log) |
| Full DR drill (matched DB/blob pair + config + known-client decrypt) | Monthly | (operator log) |
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
