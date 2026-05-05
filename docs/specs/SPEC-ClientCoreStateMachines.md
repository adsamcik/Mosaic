# SPEC: Client Core State Machines

## Status

Locked for R-Cl1 upload state-machine DTO finalization. This SPEC is governed by ADR-011, ADR-013, ADR-018, ADR-022, and ADR-023. AlbumSync remains the legacy/R-Cl2 reducer surface in this file: existing AlbumSync behavior and tests are preserved, but the frozen AlbumSync DTO/CBOR contract is not finalized by R-Cl1.

## Scope and zero-knowledge invariant

The upload reducer is a pure client-side state machine. It receives opaque UUIDv7 identifiers, shard commitments, retry inputs, sync outcomes, and effect IDs from adapters. It never reads clocks, randomness, files, HTTP, media bytes, plaintext metadata, keys, captions, EXIF, GPS, filenames, URIs, or device metadata. Server-visible data remains encrypted/opaque; `sha256` values are commitments over encrypted envelope bytes.

## Upload job snapshot: frozen canonical CBOR v1

`UploadJobSnapshot` is persisted as canonical CBOR linked to ADR-023 and `docs/specs/SPEC-ClientCoreSnapshotSchema.md`. Top-level map keys are integer-only, sorted, exact, and append-only. R-Cl1 v1 decoders reject unknown/missing keys, non-canonical order, text values, string keys, all CBOR tags, floats, invalid UUIDv7 bytes, invalid phase numerics, retry bound violations, duplicate shard coordinates, zero-length shard refs, and all-zero SHA-256 commitments. Snapshot bytes are capped before decode for a 10,000-shard upper bound.

| Key | Field | Type | Normative rules |
|---:|---|---|---|
| 0 | `schema_version` | `u16` | Must be `1`; newer versions are rejected. |
| 1 | `job_id` | UUIDv7 bytes | Client-generated opaque upload job id; debug-redacted. |
| 2 | `album_id` | UUIDv7 bytes | Opaque album id; no plaintext metadata. |
| 3 | `phase` | `u8` | Must match `UploadJobPhase` table below. |
| 4 | `retry_count` | `u8` | `<= max_retry_count`; resets to `0` on forward progress. |
| 5 | `max_retry_count` | `u8` | `<= MAX_RETRY_COUNT_LIMIT (64)`. |
| 6 | `next_retry_not_before_ms` | `null` or `i64` | Absolute adapter-clock gate; reducer does not read time. |
| 7 | `idempotency_key` | UUIDv7 bytes | ADR-022 manifest idempotency key; the backend idempotency window is 30 days and adapters must treat expiry as `IdempotencyExpired`. |
| 8 | `tiered_shards` | array of shard maps | At most 10,000; unique `(tier, shard_index)`. |
| 9 | `shard_set_hash` | `null` or 32 bytes | Commitment for ADR-022 manifest recovery; debug-redacted. |
| 10 | `snapshot_revision` | `u64` | Increments for non-idempotent accepted events only. |
| 11 | `last_acknowledged_effect_id` | `null` or UUIDv7 bytes | Last host-acknowledged effect id; informational and never used for replay dedup. |
| 12 | `last_applied_event_id` | `null` or UUIDv7 bytes | Crash-replay idempotency marker for phase-changing events. |
| 13 | `failure_code` | `null` or `u16` | Persisted `ClientErrorCode` cause for `Failed`/`Cancelled`; canonical source of failure cause. |

`asset_id` is intentionally not persisted in the frozen v1 snapshot. ADR-022 recovery gets `asset_id` from the event/effect boundary (`ManifestOutcomeUnknown` -> `RecoverManifestThroughSync`) so the persisted key set remains append-only. R-Cl1 adds keys 12 and 13 in the ADR-023 reserved v1 growth range; existing keys 0..=11 keep their numeric meanings.

### UploadShardRef CBOR map

Nested shard maps contain exactly integer keys `0..=6` in ascending order.

| Key | Field | Type | Normative rules |
|---:|---|---|---|
| 0 | `tier` | `u8` | `1=thumb`, `2=preview`, `3=original`. |
| 1 | `shard_index` | `u32` | Unique with tier within a snapshot. |
| 2 | `shard_id` | UUIDv7 bytes | Client-generated immutable shard storage id. |
| 3 | `sha256` | 32 bytes | Non-zero SHA-256 over encrypted envelope bytes. |
| 4 | `content_length` | `u64` | Must be >0. |
| 5 | `envelope_version` | `u8` | Must be `3` or `4`; values cite ADR-013 envelope-version governance. |
| 6 | `uploaded` | bool | Only mutable shard field; may transition `false -> true`. |

Upsert immutability: after a shard coordinate exists, `shard_id`, `sha256`, `content_length`, and `envelope_version` must not change. The only allowed mutation is `uploaded: false -> true` after `ShardUploaded`.

## Upload phases

`UploadJobPhase` is `#[repr(u8)]` and append-only.

| Value | Phase | Meaning |
|---:|---|---|
| 0 | `Queued` | Job is created but no work effect emitted. |
| 1 | `AwaitingPreparedMedia` | Waiting for media/tier planning. |
| 2 | `AwaitingEpochHandle` | Waiting for an epoch/tier-key handle. |
| 3 | `EncryptingShard` | Adapter should encrypt next unuploaded shard. |
| 4 | `CreatingShardUpload` | Adapter should create/resume Tus upload for a shard. |
| 5 | `UploadingShard` | Adapter should upload encrypted shard bytes. |
| 6 | `CreatingManifest` | Adapter should POST ADR-022 manifest with idempotency key. |
| 7 | `ManifestCommitUnknown` | Manifest POST outcome is unknown; recover via sync. |
| 8 | `AwaitingSyncConfirmation` | Waiting for album sync confirmation. |
| 9 | `RetryWaiting` | Timer gate before retrying a caller-specified target phase. |
| 10 | `Confirmed` | Terminal success. |
| 11 | `Cancelled` | Terminal cancellation. |
| 12 | `Failed` | Terminal failure. |

### Upload retry/resume consistency

For every upload phase, accepting `RetryableFailure` and resumability from
`RetryWaiting` are the same contract. These two columns must agree for every
phase. The `upload_retryable_phase_consistency_every_accepted_retry_resumes`
Rust test enforces this invariant so `upload_phase_allows_retry` cannot drift
from retry-timer resume behavior.

| Phase | Accepts `RetryableFailure`? | Resumable from `RetryWaiting`? |
|---|---:|---:|
| `Queued` | No | No |
| `AwaitingPreparedMedia` | Yes | Yes |
| `AwaitingEpochHandle` | Yes | Yes |
| `EncryptingShard` | Yes | Yes |
| `CreatingShardUpload` | Yes | Yes |
| `UploadingShard` | Yes | Yes |
| `CreatingManifest` | Yes | Yes |
| `ManifestCommitUnknown` | No | No |
| `AwaitingSyncConfirmation` | Yes | Yes |
| `RetryWaiting` | No | No |
| `Confirmed` | No | No |
| `Cancelled` | No | No |
| `Failed` | No | No |

## Upload event taxonomy

Every event carries a UUIDv7 `effect_id`. If a non-`EffectAck` incoming event's `effect_id == snapshot.last_applied_event_id`, the reducer returns `{ next_snapshot: snapshot, effects: [] }` with no revision bump. This is the crash replay idempotency rule for dropped acknowledgements. `EffectAck` updates only `last_acknowledged_effect_id` and cannot poison replay dedup.

| Event | Fields beyond `effect_id` | Valid source phases | Result/effects |
|---|---|---|---|
| `StartRequested` | none | `Queued` | `AwaitingPreparedMedia`; `PrepareMedia`. |
| `MediaPrepared` | `tiered_shards`, `shard_set_hash` | `AwaitingPreparedMedia` | Stores immutable shard refs; `AwaitingEpochHandle`; `AcquireEpochHandle`. |
| `EpochHandleAcquired` | none | `AwaitingEpochHandle` | `EncryptingShard`; `EncryptShard` for first unuploaded shard; retry reset. |
| `ShardEncrypted` | `shard` | `EncryptingShard` | Validates immutable ref; `CreatingShardUpload`; `CreateShardUpload`. |
| `ShardUploadCreated` | `shard` | `CreatingShardUpload` | Validates immutable ref; `UploadingShard`; `UploadShard`. |
| `ShardUploaded` | `shard` | `UploadingShard` | Marks uploaded; next `EncryptShard` or `CreatingManifest` + `CreateManifest`; retry reset. |
| `ManifestCreated` | none | `CreatingManifest` | `AwaitingSyncConfirmation`; `AwaitSyncConfirmation`. |
| `ManifestOutcomeUnknown` | `asset_id`, `since_metadata_version` | `CreatingManifest`, `ManifestCommitUnknown` | `ManifestCommitUnknown`; `RecoverManifestThroughSync`. |
| `ManifestRecoveryResolved` | `outcome`, `now_ms`, `base_backoff_ms`, `server_retry_after_ms` | `ManifestCommitUnknown` | See recovery table. |
| `SyncConfirmed` | none | `AwaitingSyncConfirmation`, `ManifestCommitUnknown` | `Confirmed`; no effects; retry reset. |
| `EffectAck` | none | any valid snapshot | Records `last_acknowledged_effect_id`/revision only; does not mutate `last_applied_event_id`. |
| `RetryableFailure` | `code`, `now_ms`, `base_backoff_ms`, `server_retry_after_ms` | retryable active phases | `RetryWaiting`; `ScheduleRetry`, or `Failed` when exhausted. |
| `RetryTimerElapsed` | `target_phase` | `RetryWaiting` | Resumes exactly non-terminal `target_phase`; terminal targets (`Confirmed`, `Cancelled`, `Failed`) are invalid transitions. |
| `CancelRequested` | none | non-terminal | `Cancelled`; `CleanupStaging(UserCancelled)`. |
| `AlbumDeleted` | none | non-terminal | `Cancelled`; `CleanupStaging(AlbumDeleted)` per ADR-011. |
| `NonRetryableFailure` | `code` | non-terminal | `Failed`; `CleanupStaging(Failed)`. |
| `IdempotencyExpired` | none | non-terminal | `Failed`; `CleanupStaging(Failed)`. |

## Upload effect taxonomy

Every effect carries the deterministic event `effect_id` that caused it.

| Effect | Fields | Adapter obligation |
|---|---|---|
| `PrepareMedia` | `effect_id` | Generate encrypted-media tier plan without leaking plaintext metadata. |
| `AcquireEpochHandle` | `effect_id` | Acquire client-local epoch/tier-key handle. |
| `EncryptShard` | `effect_id`, `tier`, `shard_index` | Encrypt the selected shard client-side. |
| `CreateShardUpload` | `effect_id`, `shard` | Create/resume upload using immutable shard id. |
| `UploadShard` | `effect_id`, `shard` | Upload encrypted bytes only. |
| `CreateManifest` | `effect_id`, `idempotency_key`, `tiered_shards`, `shard_set_hash` | POST ADR-022 manifest with deterministic idempotency; telemetry/error codes cite ADR-018. |
| `AwaitSyncConfirmation` | `effect_id` | Trigger/wait for sync confirmation. |
| `RecoverManifestThroughSync` | `effect_id`, `asset_id`, `since_metadata_version`, `shard_set_hash` | Scan sync results per ADR-022 recovery law. |
| `ScheduleRetry` | `effect_id`, `attempt`, `not_before_ms`, `target_phase` | Persist timer and later emit `RetryTimerElapsed { target_phase }`. |
| `CleanupStaging` | `effect_id`, `reason` | Delete local staging state; never touch committed encrypted blobs. |

## Backoff law

The reducer never reads a clock. Events supply `now_ms` and adapter/server retry hints.

```text
computed = base_backoff_ms.saturating_mul(2u64.saturating_pow(attempt))
delay = max(server_retry_after_ms.unwrap_or(0), computed).clamp(1_000, 300_000)
not_before_ms = now_ms + delay
```

Per ADR-018, retry/failure telemetry uses stable `ClientErrorCode` values. `attempt` in `ScheduleRetry` is the retry count before incrementing the persisted snapshot. Retry budget is capped by `MAX_RETRY_COUNT_LIMIT = 64`. Forward progress (`MediaPrepared`, `EpochHandleAcquired`, shard progress, manifest success, sync confirmation, recovery match) resets retry fields.

Because the frozen snapshot has no retry-target key, `RetryTimerElapsed` carries `target_phase`. Adapters must persist the scheduled `target_phase` alongside the timer/effect journal and replay it into the event. The reducer must not infer manifest retry from shard phases and must not jump from shard phases to `CreatingManifest` unless `target_phase == CreatingManifest`.

## ADR-018 telemetry counters

The Rust client core exposes an ADR-018 counter-only telemetry ring buffer at
`mosaic_client::telemetry::TelemetryRingBuffer`. Counters are local-first,
bounded, aggregable diagnostics; they carry no event payloads and no
correlatable identifiers. Counter names are compile-time `&'static str`
constants, so callers cannot construct names from `job_id`, `asset_id`,
`album_id`, `account_id`, server response strings, encrypted bytes, or any
other user-correlatable value.

The buffer retains at most `DEFAULT_CAPACITY = 256` distinct counter names.
When full, incrementing a new counter evicts the least-recently-incremented
counter. Snapshots are deterministic name-sorted `(String, u64)` tuples.
`set_enabled(false)` is the runtime kill-switch: it clears local counters,
causes future increments to be ignored, and makes snapshots empty until
re-enabled. `to_diagnostic_payload()` serializes the deterministic snapshot as
CBOR only; sealed-box wrapping under the operator diagnostic X25519 public key
is adapter/operator-config scope per ADR-018 §III.B.

Reducer telemetry is explicit and testable through
`advance_upload_job_with_telemetry`, `advance_album_sync_with_telemetry`, and
`UploadJobSnapshot::from_canonical_cbor_with_telemetry`. Existing pure reducer
entry points remain available and delegate with no telemetry sink. The wired
counter names are:

| Counter | Increment point |
|---|---|
| `manifest_commit_unknown_retry_rejected` | `ManifestCommitUnknown` rejects a generic `RetryableFailure`. |
| `album_sync_exhaustion_with_originating_code` | AlbumSync exhausts retry budget while preserving a non-default originating `ClientErrorCode`. |
| `legacy_retry_waiting_manifest_commit_unknown_migrated` | Legacy upload snapshot migration restores a stuck `RetryWaiting` snapshot to `ManifestCommitUnknown`. |
| `effect_ack_dedup_drop` | Duplicate `EffectAck` is dropped without mutating state. |

## Manifest-unknown recovery table (ADR-022)

| Sync/recovery outcome | Required comparison | Reducer result |
|---|---|---|
| `Match` | `asset_id` and `shard_set_hash` match the committed sync result | `Confirmed`; no cleanup. |
| `ShardSetConflict` | `asset_id` matches but shard-set commitment differs | `Failed`; `CleanupStaging(Failed)`; `failure_code = ManifestSetConflict`; cleanup reason remains presentation-only. |
| `NotFoundTimedOut` | No matching sync result before adapter timeout | `RetryWaiting` + `ScheduleRetry { target_phase: CreatingManifest }` while budget remains; exhausted budget fails. |
| `IdempotencyExpired` | Backend idempotency window expired | `Failed`; `CleanupStaging(Failed)`; `failure_code = IdempotencyExpired`; cleanup reason remains presentation-only. |

`RecoverManifestThroughSync` includes `asset_id`, `since_metadata_version`, and `shard_set_hash` so ADR-022 recovery can query only sync deltas needed to classify the outcome. `asset_id` is event/effect scoped and not persisted in snapshot v1. ADR-022 idempotency records expire after 30 days; expiry is represented by persisted `failure_code = IdempotencyExpired`.

## ADR-011 album deletion interaction

`AlbumDeleted` during any non-terminal upload phase transitions to `Cancelled` and emits `CleanupStaging { reason: AlbumDeleted }`. Adapters must not retry manifest commits after this event. This applies especially to `EncryptingShard`, `UploadingShard`, `CreatingManifest`, `ManifestCommitUnknown`, and `AwaitingSyncConfirmation`.

## AlbumSync DTOs: finalized R-Cl2 v1 shape

R-Cl2 finalizes the sync state-machine DTO shape for v1. The reducer surface is
client-side only: it carries opaque album/sync ids, cursor tokens, page counts,
retry metadata, and stable `ClientErrorCode` values. It does not carry plaintext
photo bytes, metadata, keys, filenames, EXIF, GPS, device metadata, or raw URIs.

R-Cl2 does not introduce a new AlbumSync canonical-CBOR encoder. Existing
`snapshot_schema::AlbumSyncSnapshotPlaceholder` remains R-Cl3 migration
scaffolding and is not the authoritative reducer DTO. Therefore
`SNAPSHOT_SCHEMA_VERSION_V1 == 1` remains unchanged.

### AlbumSyncRequest

| Field | Type | Normative rules |
|---|---|---|
| `sync_id` | `String` | Opaque adapter-generated sync/run id. |
| `album_id` | `String` | Opaque album id; never parsed as plaintext metadata. |
| `initial_page_token` | `Option<String>` | `None` means start from the beginning. |
| `max_retry_count` | `u32` | Retry budget copied into `AlbumSyncRetryMetadata.max_attempts`. |

### AlbumSyncSnapshot

| Field | Type | Normative rules |
|---|---|---|
| `schema_version` | `u16` | Must be `SNAPSHOT_SCHEMA_VERSION_V1` for v1 snapshots. |
| `sync_id` | `String` | Opaque sync/run id. |
| `album_id` | `String` | Opaque album id. |
| `phase` | `AlbumSyncPhase` (`#[repr(u8)]`) | Must match the discriminant table below. |
| `initial_page_token` | `Option<String>` | Cursor used to restart a rerun cycle. |
| `next_page_token` | `Option<String>` | Cursor for the next `FetchPage` effect. |
| `current_page` | `Option<SyncPageSummary>` | Present only while applying a fetched page. |
| `rerun_requested` | `bool` | Coalesces `SyncRequested` while active/retry-waiting. |
| `completed_cycle_count` | `u32` | Saturating count of complete sync cycles. |
| `retry` | `AlbumSyncRetryMetadata` | Retry attempt, target, delay, and error breadcrumbs. |
| `failure_code` | `Option<ClientErrorCode>` | Terminal failure/cancel cause when available. |

### SyncPageSummary

| Field | Type | Normative rules |
|---|---|---|
| `previous_page_token` | `Option<String>` | Cursor that produced this page. |
| `next_page_token` | `Option<String>` | Cursor for the following page. |
| `reached_end` | `bool` | `true` completes the cycle after `PageApplied`. |
| `encrypted_item_count` | `u32` | Count only; no plaintext item metadata. |

### AlbumSyncRetryMetadata

| Field | Type | Normative rules |
|---|---|---|
| `attempt_count` | `u32` | Incremented on accepted retryable failures. |
| `max_attempts` | `u32` | Exhaustion when `attempt_count >= max_attempts`. |
| `retry_after_ms` | `Option<u64>` | Adapter/server delay hint; reducer reads no clock. |
| `last_error_code` | `Option<ClientErrorCode>` | Last retry/failure code. |
| `last_error_stage` | `Option<AlbumSyncPhase>` | Source phase for the last retry/failure. |
| `retry_target_phase` | `Option<AlbumSyncPhase>` | Required when `phase == RetryWaiting`. |

### AlbumSync events and effects

| DTO | Variant | Fields |
|---|---|---|
| `AlbumSyncEvent` | `SyncRequested` | `request: Option<AlbumSyncRequest>` |
| `AlbumSyncEvent` | `PageFetched` | `page: Option<SyncPageSummary>` |
| `AlbumSyncEvent` | `PageApplied` | none |
| `AlbumSyncEvent` | `RetryableFailure` | `code: ClientErrorCode`, `retry_after_ms: Option<u64>` |
| `AlbumSyncEvent` | `RetryTimerElapsed` | none |
| `AlbumSyncEvent` | `CancelRequested` | none |
| `AlbumSyncEvent` | `NonRetryableFailure` | `code: ClientErrorCode` |
| `AlbumSyncEffect` | `FetchPage` | `page_token: Option<String>` |
| `AlbumSyncEffect` | `ApplyPage` | `encrypted_item_count: u32` |
| `AlbumSyncEffect` | `ScheduleRetry` | `attempt: u32`, `retry_after_ms: u64`, `target_phase: AlbumSyncPhase` |
| `AlbumSyncTransition` | record | `snapshot: AlbumSyncSnapshot`, `effects: Vec<AlbumSyncEffect>` |

### AlbumSync phases

`AlbumSyncPhase` is `#[repr(u8)]`, append-only, and exposes
`to_u8()`/`try_from_u8()` for discriminant-exhaustive lock tests.

| Value | Phase | Meaning |
|---:|---|---|
| 0 | `Idle` | Coordinator exists but no sync is active. |
| 1 | `FetchingPage` | Adapter should fetch the page at `next_page_token`. |
| 2 | `ApplyingPage` | Adapter should apply encrypted item summaries from `current_page`. |
| 3 | `RetryWaiting` | Timer gate before resuming `retry.retry_target_phase`. |
| 4 | `Completed` | Terminal successful cycle until a new `SyncRequested`. |
| 5 | `Cancelled` | Terminal cancellation until a new `SyncRequested`. |
| 6 | `Failed` | Terminal failure until a new `SyncRequested`. |

On AlbumSync retry-budget exhaustion, `failure_code` MUST be the originating
`code` from the `RetryableFailure` event, NOT
`ClientCoreRetryBudgetExhausted`. Budget exhaustion is signaled by
`phase=Failed AND retry.attempt_count >= retry.max_attempts`. The retry
breadcrumb fields `retry.last_error_code` and `retry.last_error_stage` MUST be
updated to the originating code and source phase at the exhaustion boundary.

### AlbumSync FFI/WASM surface

UniFFI and WASM expose compact `ClientCoreAlbumSync*` facade records for platform
adapters. Those records continue to use string phase labels and empty-string
sentinels for cross-language compatibility; the authoritative reducer phase
allocation remains the internal `#[repr(u8)] AlbumSyncPhase` table above. R-Cl2
does not change the FFI/WASM API shape or regenerate golden bindings.

### R-Cl2 lock-test inventory

| Test | Coverage |
|---|---|
| `album_sync_phase_discriminants_are_frozen` | Pins every `AlbumSyncPhase as u8` value and `to_u8()`. |
| `album_sync_phase_iteration_is_discriminant_exhaustive` | Scans every byte through `try_from_u8()` and asserts the exact phase set. |
| `album_sync_dto_field_shape_is_locked` | Compile-locks all `AlbumSyncSnapshot`, `SyncPageSummary`, and `AlbumSyncRetryMetadata` fields and types. |
| `album_sync_event_and_effect_field_shapes_are_locked` | Compile-locks all AlbumSync event/effect variants and fields. |
| Existing `album_sync_phase_lock.rs` tests | Preserve terminal/idempotent cancellation behavior, retry target validation, phase matrix, and retry-budget cause preservation. |

R-Cl2 finalization complete: commit recorded by the implementing change.

## Verification plan

| Test file | Required coverage |
|---|---|
| `upload_state_machine_locked.rs` | Phase numerics, golden canonical CBOR, c2/c3 byte regression, strict CBOR rejection, backoff table, ADR-022 recovery table, ADR-011 cleanup, effect-id idempotency, EffectAck replay-dedup split, failure_code persistence, retryable-phase/resume consistency, ManifestCommitUnknown retry-trap rejection. |
| `album_sync_phase_lock.rs` | AlbumSync phase discriminants, `try_from_u8()` byte exhaustivity, DTO/event/effect field-shape locks, phase matrix, terminal/idempotent cancellation behavior, retry target validation, and retry-budget exhaustion cause preservation. |
| `upload_state_machine_replay.rs` | Encode/decode post-state then re-apply same event/effect id and assert no effects/no revision bump. |
| Existing `mosaic-client` tests | Compile against R-Cl1 DTOs and preserve AlbumSync behavior. |
| Architecture script | Rust boundary remains clean and no forbidden cross-crate dependency is introduced. |

