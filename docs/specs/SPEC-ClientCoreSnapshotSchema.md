# SPEC: Client Core Snapshot Schema

## Status

Locked at snapshot schema version v1. Existing integer keys and phase numeric allocations are append-only.

This SPEC is governed by [ADR-023: Persisted snapshot schema strategy](../adr/ADR-023-persisted-snapshot-schema.md) §"Decision" and §"Consequences". CI enforcement lives in `crates/mosaic-client/tests/phase_enum_lock.rs` and `crates/mosaic-client/tests/snapshot_key_registry_lock.rs`.

## Scope

This document defines the durable on-device wire format for:

- `UploadJobSnapshot` persisted by web IDB (`mosaic-upload-jobs`) and Android Room (`upload_job_snapshots`).
- `AlbumSyncSnapshot` persisted by web IDB (`mosaic-album-sync`) and Android Room (`album_sync_snapshots`).
- The migration coordinate, schema-level decode validation, phase numeric allocations, and integer-key registries used by R-Cl1 and R-Cl2 when they finalize concrete v1 snapshot fields.

Out of scope:

- The complete concrete field type layout for `UploadJobSnapshot`; R-Cl1 locks that additively on top of this registry.
- The complete concrete field type layout for `AlbumSyncSnapshot`; R-Cl2 locks that additively on top of this registry.
- Platform persistence transaction APIs. IDB and Room consume opaque CBOR bytes and implement CAS per ADR-023 §"Persistence transactions and CAS".

## Governance

- **ADR-023** is the source of truth for canonical CBOR, integer map keys, `schema_version`, phase enum representation, validation rules, storage layout, migration obligations, and reversibility posture (ADR-023 §"Single canonical wire format: CBOR canonical encoding via `ciborium`", §"`schema_version: u16` is the single migration coordinate", §"Phase enum representation: numeric `u8` with append-only allocation", §"Validation rules at decode time", and §"Migration test obligations (per R-Cl3)").
- **ADR-022** binds upload snapshots to manifest finalization by requiring persisted `Idempotency-Key` and `shardId`s for retry/recovery, and by defining `tieredShards` fields referenced by the upload snapshot key registry (ADR-022 §"`POST /api/manifests` request shape (frozen)" and §"Rules").
- **Lock tests** pin all v1 numeric allocations. Existing rows cannot be reordered, renumbered, renamed with a different meaning, or reused after deprecation.
- **ADR amendment workflow:** any backward-incompatible change requires a new ADR or ADR-023 amendment, a schema version bump, migration vectors, lock-test updates, and cross-platform fixture proof. Additive fields use the next available integer key.

## Wire format

Snapshots are encoded as canonical CBOR via the exact pinned Rust crate `ciborium = "=0.2.2"`.

Top-level snapshot values are CBOR maps with these constraints:

- Map keys are integer keys only. The registry uses non-negative `u32` values.
- String keys are rejected at decode time; forbidden string keys listed below return `SnapshotMigrationError::ForbiddenField`.
- `schema_version` is a `u16` value at integer key `0`.
- Key `0` must be the first top-level map key in canonical order. Any decoded map where key `0` exists but is not first is treated as corrupt.
- Phase enums are serialized as `u8` values using the append-only tables in this SPEC.
- Forbidden field types are rejected by the schema framework: `f32`/`f64` payloads, non-integer map keys, and arbitrary-precision integer tags (`CBOR tag 2` / `CBOR tag 3`).

Persistence layers store the bytes opaquely:

- Web IDB stores the CBOR byte array under the platform-private job or album key.
- Android Room stores the CBOR byte array in a `BLOB` column.
- Neither platform parses per-field columns or indexes snapshot internals.

## Integer-key registry — `UploadJobSnapshot`

Keys `12..=127` are reserved for v1+ append-only growth.

| Key | Name | Type / planned type |
|---:|---|---|
| 0 | `schema_version` | `u16` |
| 1 | `job_id` | UUIDv7 bytes / opaque job identifier |
| 2 | `album_id` | UUIDv7 bytes / opaque album identifier |
| 3 | `phase` | `u8` using `UploadJobPhase` allocation |
| 4 | `retry_count` | bounded integer; R-Cl1 finalizes exact width |
| 5 | `max_retry_count` | bounded integer, `<= MAX_RETRY_COUNT_LIMIT (64)` |
| 6 | `next_retry_not_before_ms` | reducer-supplied absolute timestamp in milliseconds |
| 7 | `idempotency_key` | UUIDv7 bytes for manifest/Tus idempotency |
| 8 | `tiered_shards` | array of canonical CBOR maps shaped by ADR-022 `tieredShards` |
| 9 | `shard_set_hash` | 32 bytes |
| 10 | `snapshot_revision` | monotonic `u64` CAS coordinate |
| 11 | `last_effect_id` | UUIDv7 bytes when present |

## Integer-key registry — `AlbumSyncSnapshot`

Keys `11..=127` are reserved for v1+ append-only growth.

| Key | Name | Type / planned type |
|---:|---|---|
| 0 | `schema_version` | `u16` |
| 1 | `album_id` | UUIDv7 bytes / opaque album identifier |
| 2 | `phase` | `u8` using `AlbumSyncPhase` allocation |
| 3 | `cursor` | opaque encrypted-sync cursor bytes/string; R-Cl2 finalizes exact type |
| 4 | `page_hash` | hash of the last fetched/applied page |
| 5 | `retry_count` | bounded integer; R-Cl2 finalizes exact width |
| 6 | `max_retry_count` | bounded integer, `<= MAX_RETRY_COUNT_LIMIT (64)` |
| 7 | `next_retry_not_before_ms` | reducer-supplied absolute timestamp in milliseconds |
| 8 | `snapshot_revision` | monotonic `u64` CAS coordinate |
| 9 | `last_effect_id` | UUIDv7 bytes when present |
| 10 | `rerun_requested` | boolean dedup/re-run marker |

## Phase numeric allocations — `UploadJobPhase`

| Code | Phase |
|---:|---|
| 0 | `Queued` |
| 1 | `AwaitingPreparedMedia` |
| 2 | `AwaitingEpochHandle` |
| 3 | `EncryptingShard` |
| 4 | `CreatingShardUpload` |
| 5 | `UploadingShard` |
| 6 | `CreatingManifest` |
| 7 | `ManifestCommitUnknown` |
| 8 | `AwaitingSyncConfirmation` |
| 9 | `RetryWaiting` |
| 10 | `Confirmed` |
| 11 | `Cancelled` |
| 12 | `Failed` |

## Phase numeric allocations — `AlbumSyncPhase`

| Code | Phase |
|---:|---|
| 0 | `Idle` |
| 1 | `FetchingPage` |
| 2 | `ApplyingPage` |
| 3 | `RetryWaiting` |
| 4 | `Completed` |
| 5 | `Cancelled` |
| 6 | `Failed` |

The two phase enums are type-distinct. Numeric overlap is permitted only inside the correct snapshot type namespace; tools that display raw phase values must include the snapshot type discriminator, per ADR-023 §"Phase enum representation: numeric `u8` with append-only allocation".

## Validation rules at decode time

Every snapshot decode validates the six ADR-023 rules:

1. `schema_version <= CURRENT`.
2. Phase numeric value is in the allocated set for that schema version.
3. `retry_count <= max_retry_count <= MAX_RETRY_COUNT_LIMIT (64)`.
4. `effect_id` (when present) is a valid UUIDv7.
5. `snapshot_revision` is monotonically non-decreasing across reads of the same snapshot (CAS guarantee).
6. No raw key bytes, plaintext media bytes, raw URIs, or file names. These classes are excluded by concrete struct definitions and reinforced by rejecting CBOR maps with forbidden field names.

R-Cl3 enforces the schema-level subset now:

- Rule 1: `schema_version` is decoded from integer key `0`; versions greater than `CURRENT_SNAPSHOT_SCHEMA_VERSION` return `SnapshotMigrationError::SchemaTooNew`.
- Rule 5 (schema framework portion): `snapshot_revision` has a reserved integer key in each registry, so CAS validators have a stable coordinate.
- Rule 6 (defense in depth): string map keys are rejected; matching forbidden names return `SnapshotMigrationError::ForbiddenField`.
- Structural validation: root map must expose `schema_version` at key `0`; non-integer map keys, floats, arbitrary-precision integer tags, and excessive CBOR nesting depth are rejected.

R-Cl1/R-Cl2 enforce the field-dependent subset when concrete v1 fields land:

- Rule 2: phase values are checked against the per-schema phase allocations.
- Rule 3: retry fields are checked against `MAX_RETRY_COUNT_LIMIT`.
- Rule 4: `last_effect_id` / effect IDs are decoded and validated as UUIDv7.
- Rule 5 (stateful portion): persistence adapters enforce monotonic CAS across reads/writes.

## Migration workflow

All migrations enter through:

```rust
pub fn upgrade_upload_job_snapshot(bytes: &[u8])
    -> Result<UploadJobSnapshot, SnapshotMigrationError>;

pub fn upgrade_album_sync_snapshot(bytes: &[u8])
    -> Result<AlbumSyncSnapshot, SnapshotMigrationError>;
```

R-Cl3 ships these entry points with placeholder return types while R-Cl1/R-Cl2 finalize concrete DTOs. The current R-Cl3 behavior is:

1. Decode enough CBOR to validate the schema-level invariants.
2. Read `schema_version` from integer key `0`.
3. Return `SchemaVersionMissing`, `CborDecodeFailed`, `ForbiddenField`, `SchemaCorrupt`, or `SchemaTooNew` for schema-level failures.
4. Return `StepFailed { from: 1, to: 1 }` for current-version bytes until R-Cl1/R-Cl2 replace the placeholder branch with concrete v1 decode.

R-Cl1/R-Cl2 will replace the `StepFailed { from: 1, to: 1 }` sentinel with a successful decoded-snapshot return; the lock-test branch `current_version_placeholder_branch_is_explicit_step_failed` is temporary and must be deleted/replaced when those tickets land.

When schema version `N+1` is added:

1. Append new integer keys; never reuse deleted keys.
2. Add `SNAPSHOT_SCHEMA_VERSION_V{N+1}` and update `CURRENT_SNAPSHOT_SCHEMA_VERSION`.
3. Implement pure step functions `from_vN_to_vN_plus_1`.
4. Add fixture bytes under `crates/mosaic-client/tests/fixtures/snapshots/`.
5. Add native, WASM, and UniFFI migration tests for `vN -> vN+1`, `vN -> CURRENT`, and downgrade rejection.
6. Update this SPEC and the lock tests append-only.

Downgrades are not supported. A client reading a higher `schema_version` must surface a user-visible "client out of date — please update" posture and must not advance the reducer.

## Forbidden field names list

The decoder rejects case-insensitive substring matches in string map keys with `SnapshotMigrationError::ForbiddenField`:

| Forbidden name |
|---|
| `account_key` |
| `caption` |
| `description` |
| `device_metadata` |
| `device_timestamp` |
| `epoch_seed` |
| `exif` |
| `filename` |
| `gps` |
| `gps_lat` |
| `gps_lon` |
| `key` |
| `make` |
| `master_key` |
| `model` |
| `password` |
| `plaintext` |
| `private_key` |
| `raw_uri` |
| `read_key` |
| `secret` |
| `signing_key` |
| `tier_key` |
| `uri` |

Canonical snapshots never encode string keys. This list exists as defense in depth for malformed or hostile CBOR that attempts to smuggle red-data names into a map.

## Cross-platform consumption

- **Native Rust:** `mosaic-client` owns snapshot decode, migration, validation, and future canonical encode paths.
- **Web IDB:** W-A2/W-A3 store opaque CBOR bytes. The web adapter calls Rust through WASM to decode/upgrade and uses IDB transactions for CAS.
- **Android Room:** A2b stores opaque CBOR `BLOB` values. Kotlin calls Rust through UniFFI to decode/upgrade and uses `@Transaction` DAO methods for CAS.
- **Future iOS GRDB:** iOS stores the same opaque CBOR bytes and implements the same port contract validated by the Q-final iOS stub adapter.

Every platform consumes the same Rust-produced bytes; no platform owns a parallel JSON, Room-column, or IDB-field schema for snapshot internals.

## Forward links

- R-Cl1 will lock concrete `UploadJobSnapshot` v1 field types and migration vectors using the upload key registry above.
- R-Cl2 will lock concrete `AlbumSyncSnapshot` v1 field types and migration vectors using the sync key registry above.
- P-W4 and P-U3 consume the re-exported `mosaic-client` snapshot schema symbols for WASM and UniFFI bindings.
- Future schema versions land via additive ADRs or ADR-023 amendments, append-only lock-test changes, and migration fixture vectors.
