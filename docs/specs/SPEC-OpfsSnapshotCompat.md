# SPEC: OPFS Snapshot Compatibility

> **Status:** v1.
> **Source:** P-W7.4 / R-C6 / R-C6.1 / R-M5.2.2 / R-Cl1.2 follow-up.

## 1. Current `SNAPSHOT_VERSION`

The current OPFS SQLite snapshot envelope version is **v4**:

```ts
export const SNAPSHOT_VERSION = 4 as const;
```

The constant lives in `apps/web/src/workers/db.worker.ts`. The on-disk layout
is:

```text
[u8 SNAPSHOT_VERSION][...account-handle wrap blob...]
```

The wrapped blob keeps the Rust account-handle wrap wire shape:

```text
nonce(24) || ciphertext_with_tag(16)
```

The version byte is not part of the Rust AEAD wire blob. It is a web OPFS cache
envelope discriminator that tells the DB worker whether cached bytes are
compatible with the current account-data wrapping semantics.

## 2. v3 -> v4 Invalidation

R-C6 introduced AEAD domain separation for account-data wraps. OPFS snapshots
stored under v3 used the same `nonce || ciphertext || tag` wire bytes but were
wrapped with empty AAD. v4 wraps bind account-data snapshots to the explicit
AAD label:

```text
mosaic:account-wrapped-data:v1
```

Cross-version unwrap therefore fails with `AuthenticationFailed` because the
ciphertext was produced under a different AAD domain.

User impact: on first launch after the v4 client ships, the web DB worker drops
the incompatible OPFS cache and reinitializes an empty local SQLite database.
The sync engine then re-fetches encrypted state from the server. Encrypted
server blobs are unchanged; there is no server-side migration and no data loss.
Only client-side cached unwrapped state is invalidated.

## 3. Forward Compatibility: Future Bumps

A `SNAPSHOT_VERSION` bump is required when cached OPFS bytes can no longer be
read under the current client semantics, including:

- AAD labels for account-data, epoch, identity, or related wraps change.
- The wire format for OPFS-persisted wrapped blobs changes.
- The persisted SQLite snapshot semantics change in a way that cannot be
  safely interpreted by the current DB worker.
- Cap values or validation rules change in a way that would retroactively
  reject data that was valid before the bump. R-M5.2.2 tightened sidecar caps
  pre-v1 to avoid creating this kind of post-v1 incompatibility.

Do not bump `SNAPSHOT_VERSION` for semantically equivalent inline repairs. For
example, the R-Cl1.2 follow-up legacy snapshot migration rewrites stuck
`RetryWaiting` + `ManifestCommitUnknown` upload snapshots inline without an OPFS
snapshot version bump because the logical state remains compatible.

When bumping:

1. Increment `SNAPSHOT_VERSION` in `apps/web/src/workers/db.worker.ts`.
2. Add or update the load-time handler so old versions either migrate safely or
   are dropped as a cache invalidation that triggers server re-fetch.
3. Document the migration in this SPEC and in the relevant ADR or protocol
   SPEC.
4. Add a regression test that exercises the old-version behavior.

Current policy for OPFS SQLite cache snapshots is invalidation rather than
in-place migration: the server is the source of truth and the OPFS cache can be
repopulated. A future storage-strategy ADR may change that policy, but it must
define migration vectors, browser quota implications, and FTS5 reindexing
behavior before changing `db.worker.ts`.

## 4. Relationship to Other Snapshot Versions

`SNAPSHOT_VERSION` is specific to the web OPFS SQLite cache envelope in
`db.worker.ts`. It is separate from Rust client-core persisted snapshot schema
versions for `UploadJobSnapshot` and `AlbumSyncSnapshot`, which are governed by
[`ADR-023: Persisted snapshot schema strategy`](../adr/ADR-023-persisted-snapshot-schema.md)
and [`SPEC-ClientCoreSnapshotSchema.md`](SPEC-ClientCoreSnapshotSchema.md).

The OPFS version tracks compatibility of the encrypted local SQLite cache. The
Rust client-core snapshot schema version tracks compatibility of canonical CBOR
state-machine snapshots stored opaquely in platform persistence layers.

## 5. Migration Handlers in Flight

- R-C6 v3 -> v4: hard invalidation because empty-AAD account-data wraps cannot
  authenticate under `mosaic:account-wrapped-data:v1`.
- R-C6.1 epochSeed migration: changed epoch-handle consumer paths without an
  OPFS version bump because the OPFS account-data wrap format remained v4.
- R-Cl1.2 follow-up legacy snapshot migration: `validate_upload_snapshot`
  rewrites stuck `RetryWaiting` + `ManifestCommitUnknown` snapshots inline
  without an OPFS version bump because it is semantically equivalent.

## 6. Snapshot Boundary Tests

- `apps/web/tests/db-worker-snapshot-version.test.ts` pins
  `SNAPSHOT_VERSION = 4`, verifies the leading version byte, and verifies
  mismatched versions are discarded and reinitialized.
- `apps/web/tests/db-worker-no-raw-secrets.test.ts` verifies the on-disk OPFS
  bytes carry the versioned account-handle wrap envelope without raw key
  material.
- Cross-version migration vectors for future durable migrations belong with the
  ticket that changes the OPFS storage strategy or bumps the version.

## 7. Cross-References

- [`ADR-006: Expose Rust through handle-based WASM and UniFFI APIs`](../adr/ADR-006-ffi-api-secret-handles.md)
  — handle architecture and R-C6 AAD domain separation.
- [`ADR-016: Defer web encrypted local cache (OPFS) strategy to v1.x`](../adr/ADR-016-web-opfs-encrypted-cache-deferral.md)
  — OPFS strategy freeze and v1.x reopen posture.
- [`ADR-023: Persisted snapshot schema strategy`](../adr/ADR-023-persisted-snapshot-schema.md)
  — separate Rust client-core snapshot schema migration discipline.
- [`SPEC-AeadDomainSeparation.md`](SPEC-AeadDomainSeparation.md)
  — account-data AAD label registry.
- [`SPEC-ClientCoreSnapshotSchema.md`](SPEC-ClientCoreSnapshotSchema.md)
  — Rust client-core upload/sync snapshot schema.
- [`SPEC-MetadataStripParity.md`](SPEC-MetadataStripParity.md)
  — M0 media strip boundary referenced by the web README.
