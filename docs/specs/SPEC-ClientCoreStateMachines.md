# Client Core State Machines

## Status

Locked at v1 for the contract layer. Implemented across:

- `1aa2baa` (`build(rust): add ffi facade spike`) and `a3b0ce4`
  (`build(rust): add client core workspace skeleton`) — workspace skeleton.
- `d4e2ff6` (`feat(client): add client-core state reducers`) — reducer-style
  upload/sync state machines.
- `eeb9697` (`feat(ffi): expose client-core state DTO adapters`) — UniFFI/WASM
  DTO adapters for the reducer API.
- `50cb647` (`test(client-core): add state machine contract vectors`) and
  `730d1cb` (`test(client-core): add public-API, error-mapping, and crafted-snapshot
  fixtures`) — contract vectors and snapshot regression coverage.
- `77559f7` (`fix(client-core): align FFI adapters with reducer API`) and
  `0fd7859` (`test(ffi): harden client-core snapshot regressions`) — FFI alignment.
- `407c216` (`fix(rust/ffi): strict snapshot enum decoding; metadata length cap;
  clamp-as-error (L1, L2, L4)`) — late-v1 snapshot hardening.

The full Rust ownership of upload transport, sync engine, and Android
WorkManager remain platform-side per the original goal.

## Goal

Add a Rust-native, deterministic upload/sync orchestration slice for the
Android manual upload MVP without moving platform transport, storage, media IO,
or background execution into Rust.

The slice centralizes upload lifecycle state, keeps pending uploads visible
until sync confirmation, deduplicates album sync requests, survives retries and
restarts through persisted snapshots, and exposes a small FFI-friendly API for
Android and web adapters.

Out of scope for this phase:

- Android manual upload UI or WorkManager implementation.
- Full media generation in Rust.
- Full sync/download engine rewrite.
- Backend contract changes unless Phase B explicitly proves a gap.

## Current inputs

- Rust client core is currently crypto/handle oriented.
- UniFFI exports stable records and numeric error codes for Android.
- Web upload orchestration is spread across upload queue handlers, manifest
  finalization, and sync callbacks.
- Backend manifest creation atomically links pending shards to a manifest and
  activates them, but a transport failure after the request is sent leaves the
  client unsure whether manifest creation committed.
- Android shell already separates server authentication, crypto unlock state,
  privacy-safe queued records, and the Rust account bridge seam.

## Architecture

Implement pure reducer-style state machines in `mosaic-client`. Rust owns state
enums, transition validation, emitted effects, retry/cancel semantics, and
persistence-safe snapshots. Platform adapters own media preparation, Tus
transport, backend HTTP, local DB writes, timers, background execution, and
app-private staging references.

This keeps the core deterministic, testable, and FFI-safe. Snapshots must never
contain raw keys, passwords, plaintext media, plaintext metadata, or raw picker
URIs.

## Upload job machine

One machine exists per local upload job.

Suggested phases:

| Phase | Meaning |
| --- | --- |
| `Queued` | Job exists but no irreversible work has started. |
| `AwaitingPreparedMedia` | Adapter must inspect/strip/plan media and return shard plan. |
| `AwaitingEpochHandle` | Adapter must provide an open epoch handle for encryption. |
| `EncryptingShard` | Adapter/Rust crypto is encrypting the next planned shard. |
| `CreatingShardUpload` | Adapter must initialize server-side Tus upload for a shard. |
| `UploadingShard` | Adapter must upload encrypted shard bytes. |
| `CreatingManifest` | Adapter must post the encrypted manifest and shard refs. |
| `ManifestCommitUnknown` | Manifest request outcome is unknown; recover through sync. |
| `AwaitingSyncConfirmation` | Manifest was accepted; wait until album sync confirms it. |
| `RetryWaiting` | Retryable failure is waiting for adapter-owned backoff time. |
| `Confirmed` | Sync observed the uploaded asset. |
| `Cancelled` | Job was cancelled before an irreversible commit. |
| `Failed` | Non-retryable failure or retry budget exhausted. |

Happy path:

```text
Queued
  -> AwaitingPreparedMedia
  -> AwaitingEpochHandle
  -> EncryptingShard
  -> CreatingShardUpload
  -> UploadingShard
  -> CreatingManifest
  -> AwaitingSyncConfirmation
  -> Confirmed
```

Retryable failures move to `RetryWaiting`, then back to the previous actionable
phase. Once a manifest request may have committed, cancellation is no longer a
hard cancel: the machine moves to `ManifestCommitUnknown` and requires sync
recovery.

## Album sync coordinator

One machine exists per album.

Suggested phases:

| Phase | Meaning |
| --- | --- |
| `Idle` | No sync is active. |
| `FetchingPage` | Adapter must fetch the next sync page. |
| `ApplyingPage` | Adapter must decrypt/apply the current page. |
| `RetryWaiting` | Retryable sync failure is waiting for backoff time. |
| `Completed` | Current sync cycle is done. |
| `Cancelled` | Sync was cancelled before completion. |
| `Failed` | Non-retryable failure or retry budget exhausted. |

If a sync request arrives while the same album is active, the machine should
dedupe it and record a rerun request. After the active cycle completes, it emits
one more fetch effect rather than starting parallel duplicate syncs.

## Native Rust API shape

Recommended module:

```text
crates/mosaic-client/src/state_machine.rs
```

Recommended public types:

```rust
pub struct UploadJobSnapshot { /* persistence-safe fields */ }
pub enum UploadJobPhase { /* phases above */ }
pub enum UploadJobEffect { /* adapter work requests */ }
pub enum UploadJobEvent { /* adapter completions/failures */ }
pub struct UploadJobTransition { /* next snapshot + effects */ }

pub struct AlbumSyncSnapshot { /* persistence-safe fields */ }
pub enum AlbumSyncPhase { /* phases above */ }
pub enum AlbumSyncEffect { /* adapter work requests */ }
pub enum AlbumSyncEvent { /* adapter completions/failures */ }
pub struct AlbumSyncTransition { /* next snapshot + effects */ }
```

Recommended functions:

```rust
pub fn new_upload_job(request: UploadJobRequest) -> Result<UploadJobSnapshot, ClientError>;
pub fn advance_upload_job(
    snapshot: &UploadJobSnapshot,
    event: UploadJobEvent,
) -> Result<UploadJobTransition, ClientError>;

pub fn new_album_sync(request: AlbumSyncRequest) -> Result<AlbumSyncSnapshot, ClientError>;
pub fn advance_album_sync(
    snapshot: &AlbumSyncSnapshot,
    event: AlbumSyncEvent,
) -> Result<AlbumSyncTransition, ClientError>;
```

Pure functions are preferred because they are easy to persist, export through
UniFFI/WASM, and test without platform services.

### Phase B reducer contract

The contract/vector tests define the minimal public DTO shape Phase B adapters
can rely on. Implementations may add fields, but these fields and variants must
remain stable:

- `UploadJobRequest { job_id, album_id, local_asset_id, retry_budget }`
- `UploadJobSnapshot` with persistence-safe fields:
  - `job_id`, `album_id`, `local_asset_id`
  - `phase`
  - `retry_budget`, `retry_count`, `retry_target_phase`
  - `last_error_code`, `last_error_stage`
  - `epoch_id`
  - `planned_shard_count`, `current_shard_index`,
    `completed_shard_count`
  - `manifest_id`, `manifest_version`
  - `confirmed_remote_asset_id`
- `UploadJobEvent` variants:
  - `StartRequested`
  - `ResumeRequested`
  - `PreparedMedia { planned_shard_count }`
  - `EpochHandleReady { epoch_id }`
  - `ShardEncrypted { tier, index, encrypted_sha256, encrypted_size_bytes }`
  - `ShardUploadCreated { tier, index, upload_id }`
  - `ShardUploaded { tier, index, shard_id, encrypted_sha256 }`
  - `ManifestCreated { manifest_id, version }`
  - `ManifestOutcomeUnknown { error_code }`
  - `SyncConfirmed { local_asset_id, remote_asset_id }`
  - `RetryableFailure { stage, code, retry_after_ms }`
  - `RetryTimerElapsed`
  - `CancelRequested`
- `UploadJobEffect` variants:
  - `PrepareMedia { job_id, album_id, local_asset_id }`
  - `OpenEpochHandle { job_id, album_id }`
  - `EncryptShard { job_id, epoch_id, tier, index }`
  - `CreateShardUpload { job_id, tier, index, encrypted_sha256 }`
  - `UploadShard { job_id, tier, index, upload_id }`
  - `CreateManifest { job_id, album_id, local_asset_id,
    completed_shard_count }`
  - `RequestSyncConfirmation { album_id, local_asset_id }`
  - `RecoverManifestBySync { album_id, local_asset_id }`
  - `ScheduleRetry { job_id, retry_count, target_phase, after_ms }`

Upload retry budget is the number of retry timers the reducer may schedule.
For a budget of `2`, the first two retryable failures schedule retries and the
third retryable failure transitions to `Failed` without a third timer.

`ResumeRequested` re-emits the next missing actionable effect for the current
snapshot without replaying completed shard work. If shard `0` is already marked
complete in the snapshot, recovery must continue at shard `1` and must not
request encryption, upload creation, or upload bytes for shard `0`.

Manifest recovery is keyed by `local_asset_id`. `SyncConfirmed` only confirms a
job in `ManifestCommitUnknown` or `AwaitingSyncConfirmation` when its
`local_asset_id` matches the upload snapshot.

- `AlbumSyncRequest { album_id, initial_cursor, retry_budget }`
- `AlbumSyncSnapshot` with persistence-safe fields:
  - `album_id`, `phase`, `cursor`, `retry_budget`, `retry_count`
  - `last_error_code`, `last_error_stage`
  - `rerun_requested`
- `AlbumSyncEvent` variants:
  - `StartRequested`
  - `PageFetched { requested_cursor, next_cursor, item_count, has_more }`
  - `PageApplied { applied_cursor }`
  - `RetryableFailure { stage, code, retry_after_ms }`
  - `RetryTimerElapsed`
  - `CancelRequested`
- `AlbumSyncEffect` variants:
  - `FetchPage { album_id, cursor }`
  - `ApplyPage { album_id, next_cursor, item_count, has_more }`
  - `ScheduleRetry { album_id, retry_count, target_phase, after_ms }`

A duplicate `StartRequested` for the same album while a sync is active must not
emit another `FetchPage`. It sets one sticky rerun flag; when the active cycle
finishes, the reducer emits exactly one fresh `FetchPage` and clears the flag.

When `has_more` is true, a fetched page must advance from
`requested_cursor` to a different `next_cursor`. A non-advancing page returns
the stable `ClientErrorCode::SyncPageDidNotAdvance` error instead of spinning.

The existing media adapter uses `ClientErrorCode` values in the `600..=606`
range. Client-core orchestration errors should use the next stable block
(for example `700+`) while preserving variant names such as
`SyncPageDidNotAdvance`.

## FFI boundary

The first FFI surface should be DTO-only:

- `client_core_state_machine_snapshot() -> String`
- upload/sync init functions
- upload/sync advance functions
- record/enum DTOs only

Rules:

- Persisted snapshots contain no raw handles.
- Ephemeral effects/events may reference account or epoch handles only when the
  adapter is actively executing crypto work.
- Adapter-private Tus resume tokens stay in platform storage unless a later
  threat model proves they are safe to persist in Rust snapshots.
- Raw file paths, picker URIs, and plaintext media bytes stay outside Rust
  state snapshots.

## Error, cancellation, and retry model

Reserve stable client-core orchestration error codes in a block that does not
overlap existing media-adapter codes, for example in the `700+` range:

- invalid state transition
- missing required event payload
- retry budget exhausted
- sync page did not advance
- manifest outcome unknown
- snapshot version unsupported

`CancelRequested` is an explicit event. If no irreversible side effect has
committed, it transitions to `Cancelled`. If manifest creation may already have
committed, cancellation transitions to `ManifestCommitUnknown` so sync recovery
can confirm or fail the job.

Backoff timing is adapter-driven, but the machine owns retry shape:

- retry count
- next retry timestamp
- last error code
- last error stage

## Idempotency and recovery

Shard upload is safe to retry when the snapshot already records the encrypted
shard hash, server shard id, and completed upload marker. The machine must not
re-encrypt or re-upload a shard already marked uploaded.

Manifest creation is atomic but not safely idempotent when transport outcome is
unknown:

- if a success response is received, persist manifest receipt and move to
  `AwaitingSyncConfirmation`;
- if the request was definitely not sent, retry;
- if the outcome is unknown, move to `ManifestCommitUnknown` and recover through
  album sync before any retry.

Recovery confirmation should use the locally stable `assetId` embedded in the
encrypted manifest metadata. When sync decrypts a manifest whose `assetId`
matches the local upload id, the job is `Confirmed`.

## Persistence model

Persist two records separately:

1. Platform queue record, privacy-safe and platform-owned.
2. Rust machine snapshot, persistence-safe and schema-versioned.

Snapshot fields may include:

- schema version
- upload/job id
- album id
- epoch id
- phase
- planned shard slots
- completed shard refs `{ tier, index, shard_id, sha256 }`
- manifest receipt if known `{ manifest_id, version }`
- retry metadata
- sync confirmation metadata

Snapshot fields must not include:

- raw handles
- plaintext media
- plaintext metadata
- passwords
- raw content or file URIs

## Adapter mapping

Android:

- `MediaPort` executes media preparation effects.
- Future network/worker layer executes shard init/upload, manifest POST, and
  sync GET effects.
- Privacy-safe queue records map to machine phases:
  - `PENDING`: `Queued`, `AwaitingPreparedMedia`, or `AwaitingEpochHandle`
  - `RUNNING`: active crypto/network phases
  - `RETRY_WAITING`: `RetryWaiting`
  - `FAILED`: `Failed` or `ManifestCommitUnknown`
  - `COMPLETED`: `Confirmed`

Web:

- upload handlers execute media preparation and encrypted upload effects.
- manifest service executes manifest creation effects.
- sync engine executes sync fetch/apply effects.
- pending UI should remain visible until `Confirmed`, not merely until upload
  bytes finish.

## Phase B implementation workstreams

1. Rust core:
   - add `state_machine.rs`;
   - define snapshots, phases, effects, and events;
   - add reducer tests.
2. Android bridge:
   - export DTOs through UniFFI;
   - map generated bindings into Kotlin shell types;
   - integrate with privacy-safe queue records.
3. Web adapter alignment:
   - map current upload queue, manifest service, and sync callbacks onto the new
     machine;
   - ensure pending photos survive until confirmation.
4. Recovery hardening:
   - implement `ManifestCommitUnknown` recovery through sync confirmation;
   - validate per-album sync dedupe.

## Verification plan

Rust reducer tests:

- happy-path upload progression;
- retry progression;
- cancellation before finalize;
- manifest-unknown recovery path;
- sync request dedupe;
- snapshot serialization contains no secret/plaintext fields.

Phase B validation:

- `cargo fmt --all --check`
- `cargo test -p mosaic-client --locked`
- if UniFFI changes: `cargo test -p mosaic-uniffi --locked`
- web typecheck and focused upload/sync tests after web adapter work
- Android shell tests after Kotlin bridge work
