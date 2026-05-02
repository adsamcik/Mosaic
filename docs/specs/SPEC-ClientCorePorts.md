# SPEC: Client Core Ports

## Status

Proposed for R-Cl4. This is a design document only: the Rust trait signatures
below are illustrative contract examples for R-Cl1/R-Cl2/W-A1/A13 materialization,
not committed API.

## Scope

This SPEC defines the platform-neutral ports between the pure `mosaic-client`
upload/sync reducers and platform adapters. It complements
`SPEC-WebClientCoreAdapterSeam.md` by defining the future Rust-backed adapter
surface, and it does not duplicate state-machine transition logic already owned
by `SPEC-ClientCoreStateMachines.md` and
`crates/mosaic-client/src/state_machine.rs`.

The same port set must be implementable by:

- web adapters for W-A1/W-A2/W-A3;
- Android adapters for A4/A5b/A8/A9/A10/A11/A13;
- an iOS stub adapter for Q-final-2 without changing Rust core.

## Outline

1. Cross-cutting contract rules.
2. Shared DTO vocabulary and error mapping.
3. Upload ports:
   1. `PrepareMediaPort`
   2. `EncryptShardPort`
   3. `CreateShardUploadPort`
   4. `UploadShardPort`
   5. `CreateManifestPort`
4. Sync ports:
   1. `FetchAlbumSyncPagePort`
   2. `ApplyAlbumSyncPagePort`
5. Orchestration and persistence ports:
   1. `ScheduleRetryPort`
   2. `PersistSnapshotPort`
   3. `LoadSnapshotPort`
   4. `CancelPort`
   5. `CleanupStagingPort`
6. Utility ports:
   1. `EpochHandleAcquirePort`
   2. `ClockPort`
   3. `TelemetryPort`
7. Conformance matrix.
8. Future ports.

Checklist coverage: all 15 v1 required ports are specified below, including `EpochHandleAcquirePort`.

## Normative references

| Reference | Contract used here |
| --- | --- |
| ADR-004, "Decision" and "Consequences" | Core uses ports for platform effects; adapters own HTTP, Tus, local store, media, clock, logging, and background work. |
| ADR-006, "Rules" | Raw L0/L1/L2/epoch/signing/link keys never cross WASM/Kotlin/UniFFI boundaries; long-running calls expose cancellation and redacted stable errors. |
| ADR-013, "API shape" | Streaming AEAD is deferred to v1.x; v1 upload ports use single-shot envelope v3, while `envelope_version` leaves room for v4. |
| ADR-018, "Telemetry posture" and "What ships to operators" | Diagnostic events are local-ring-buffer-first, opaque-code-only, and contain no PII or IDs. Server upload of aggregates is out of band. |
| ADR-022, "POST /api/manifests request shape" and "Rules" #11 | Manifest commit uses `Idempotency-Key`; identical key plus identical canonical body returns identical response, body mismatch returns `409 IDEMPOTENCY_CONFLICT`, and expired cache returns `409 IDEMPOTENCY_KEY_EXPIRED`. |
| ADR-023, "Single canonical wire format" and "Persistence transactions and CAS" | Snapshots are opaque canonical-CBOR blobs; `update_snapshot(id, expected_revision, new_bytes)` is compare-and-swap; sync apply is one transaction. |
| `SPEC-ClientCoreStateMachines.md`, "Error, cancellation, and retry model" | Reducers own transition, retry, cancel, and manifest-unknown semantics. |
| `SPEC-LateV1ProtocolFreeze.md`, "Rust FFI DTOs" and "Opaque blob formats" | Stable error codes are append-only; no raw-secret FFI outputs; shard envelope v3 and manifest transcript surfaces are freeze candidates/frozen by gate status. |

## Cross-cutting contract rules

### Reducer purity

- Reducers are pure functions: they consume a snapshot and an event, then emit a
  next snapshot plus effects.
- Reducers never call wall-clock time directly. Event payloads carry `now_ms`.
  `ClockPort` is the only permitted clock surface.
- `ScheduleRetryOutput.fired_at_ms` is a host-populated event payload for
  observability and replay diagnostics only; reducers must not use it for further
  wall-clock decisions, retry math, backoff, or phase selection.
- Reducers never call randomness directly. If randomness is needed for
  `effect_id`, `Idempotency-Key`, `shard_id`, or a UUIDv7, the host environment
  supplies it immediately before calling an `advance_*` function or stores it in
  the persisted effect record.
- All ports return `Result<T, PortError>`. `PortError` carries a stable
  `ClientErrorCode`, a retry classification, and a redacted message that never
  echoes user-controlled or secret data.

### Effect idempotency and replay

- Every dispatched effect carries an `effect_id`. Platform dispatchers persist
  effect start/completion before event delivery so process death between effect
  completion and reducer event commit can be replayed without duplicating
  irreversible work.
- Ports declare one of three postures:
  - **idempotent**: identical inputs and idempotency key produce the same output;
  - **retryable**: safe to retry with persisted session/output state;
  - **resume-from-persisted-output**: host reuses persisted output rather than
    re-running the effect.
- `CreateShardUploadPort` and `CreateManifestPort` are idempotent when called
  with the same persisted key and canonical body. `UploadShardPort` is
  retryable/resumable. `EncryptShardPort` is
  resume-from-persisted-output because fresh nonces make re-encryption of the
  same `(shard_id, plaintext)` a distinct ciphertext. Sync fetch/apply is
  resume-from-persisted-output through page hashes and CAS snapshots.

### Cancellation

- Long-running ports (`PrepareMediaPort`, `EncryptShardPort`,
  `UploadShardPort`, `FetchAlbumSyncPagePort`, `ApplyAlbumSyncPagePort`) accept a
  cooperative cancellation token. `CreateManifestPort` intentionally has no
  token because mid-send cancellation is indistinguishable from an outcome-
  unknown manifest commit and must be represented by the reducer's
  `ManifestCommitUnknown` path.
- Cancellation is cooperative-poll only, never preemptive. Port implementations
  poll `token.is_cancelled()` at safe points and return `PortError { code:
  OperationCancelled, .. }` when set.
- `CancellationToken` must be `Send + Sync + Clone`. It is one-shot and sticky:
  once `cancel()` is called, every current and future poll returns cancelled.
- Hosts must signal `cancel()` before dropping a port future. Dropping a future
  without signaling is a host programming error; ADR-023 CAS protects reducer
  snapshots, but platform resources, staging blobs, or Tus sessions may leak
  until cleanup.
- Adapters that wrap native runtime cancellation, such as Tokio structured
  tasks or Kotlin coroutines, must translate `cancel()` to the runtime's
  cancellation primitive and treat dropped futures as silent cancellation with
  best-effort cleanup and no completion guarantees.
- Cancellation must leave persisted snapshots consistent. Snapshot writes use
  ADR-023 CAS, and `ApplyAlbumSyncPagePort` uses a single transaction.
- A cancellation request is delivered to the reducer as `CancelRequested`.
  Pre-manifest cancellation is hard (`Cancelled`); once manifest commit may have
  happened, cancellation becomes `ManifestCommitUnknown` per
  `SPEC-ClientCoreStateMachines.md`, "Error, cancellation, and retry model".
- `OperationCancelled` may be emitted through `TelemetryPort` only as the opaque
  code plus phase/retry bucket; cancellation reason strings and user text never
  enter diagnostics.
- Conformance: every long-running port has a cancel-mid-flight test and a
  future-drop-without-signal test.

### Panic firewall

- Every port implementation that crosses WASM, UniFFI, JVM, or iOS binding
  boundaries must catch panics or platform equivalents: `catch_unwind` on Rust
  exports, `try { } catch (Throwable)` on JVM, and `@try { } @catch` on iOS.
- On panic, the implementation must zeroize any plaintext-bearing buffers in
  the worker or adapter scope and return only `PortError { code:
  InternalStatePoisoned, redacted_message: "<panic redacted>", retry:
  NonRetryable }`.
- Panic payload bytes, `Debug` strings, exception messages, stack-local
  plaintext, URLs, body bytes, and key material must not propagate into JS error
  strings, Comlink messages, logcat, NSLog, crash telemetry, or local diagnostic
  ring buffers.
- The worker/process must remain usable after a panic-firewall return unless the
  platform runtime itself aborts. If abort is unavoidable, restart code must
  still surface only `InternalStatePoisoned` to the reducer loop.
- Conformance: every port has a panic-firewall test that injects a panic in the
  implementation body and asserts a redacted `PortError` plus continued worker
  availability.

### Concurrency

- At most one in-flight effect is permitted per `(machine_id, target_phase)`.
  Reducers enforce single-flight through phase transitions; ports may assume the
  dispatcher will not issue two identical phase effects concurrently for one
  machine.
- Tier shards (`tier = 1`, `2`, `3`) within a single upload job may run as
  separate `UploadShardPort` calls concurrently only if the reducer issues those
  effects in parallel. v1 issues tier uploads sequentially per
  `SPEC-ClientCoreStateMachines.md`; ports must not create hidden parallelism.
- Different upload jobs may run concurrently when their persisted effect IDs,
  staging refs, Tus sessions, and snapshot keys are distinct.
- Album sync is single-flight per album. Duplicate sync requests are reducer-
  deduplicated with the `rerun_requested` flag from R-Cl2; ports must not start a
  second apply/fetch pipeline for the same album outside reducer control.

### Red-data boundary

Ports must never receive or emit:

- raw L0/L1/L2/epoch/signing/link key bytes;
- passwords/passphrases;
- plaintext metadata, captions, filenames, EXIF, GPS, MIME-derived names, raw
  content URIs, or platform file paths;
- account, identity, session, album, manifest, or shard IDs in telemetry events;
- request or response bodies in logs.

`EncryptShardPort` receives an opaque `EpochHandle`, never raw key material, per
ADR-006, "Rules". `PrepareMediaPort` receives an opaque staged-media reference,
not a filename, URI, or picker handle string.

### Persistence transaction rules

- Snapshot persistence uses opaque canonical-CBOR bytes and a `snapshot_revision`
  CAS check as defined by ADR-023, "Persistence transactions and CAS".
- A port may not mutate reducer snapshot fields directly. It can only return an
  event payload that the reducer validates.
- `ApplyAlbumSyncPagePort` is the only port that must combine domain data
  application and snapshot persistence in the same transaction.

### Failure code registry

Current stable `ClientErrorCode` values used by these ports include:

- `OperationCancelled`
- `EpochHandleNotFound`
- `IdentityHandleNotFound`
- `InternalStatePoisoned`
- `UnsupportedMediaFormat`
- `InvalidMediaContainer`
- `InvalidMediaDimensions`
- `MediaOutputTooLarge`
- `MediaMetadataMismatch`
- `MediaAdapterOutputMismatch`
- `InvalidEnvelope`
- `AuthenticationFailed`
- `InvalidInputLength`
- `ShardIntegrityFailed`
- `LegacyRawKeyDecryptFallback`
- `ClientCoreInvalidTransition`
- `ClientCoreRetryBudgetExhausted`
- `ClientCoreSyncPageDidNotAdvance`
- `ClientCoreManifestOutcomeUnknown`
- `ClientCoreUnsupportedSnapshotVersion`
- `ClientCoreInvalidSnapshot`
- `ManifestShapeRejected`
- `IdempotencyExpired`
- `ManifestSetConflict`
- `BackendIdempotencyConflict`

`ClientCoreManifestOutcomeUnknown` is the canonical R-C1 variant name for code
704 in `crates/mosaic-client/src/lib.rs`; do not rename it to the state-machine
event name `ManifestCommitOutcomeUnknown`.

The following additive stable codes are required before implementation tickets
materialize HTTP/Tus/storage adapters. They must be appended to the registry and
lock-tested under the same append-only policy referenced by
`SPEC-LateV1ProtocolFreeze.md`, "Rust FFI DTOs":

| Proposed code name | Failure class |
| --- | --- |
| `TransportUnauthorized` | HTTP 401/403 or missing trusted auth context. |
| `TransportTimeout` | Network timeout with unknown request delivery. |
| `TransportUnavailable` | DNS/TLS/connectivity/server 5xx retryable outage. |
| `TransportBadResponse` | Malformed response or protocol violation. |
| `TusSessionConflict` | Tus offset/session mismatch not safely resumable. |
| `RevisionConflict` | ADR-023 CAS mismatch. |
| `SnapshotNotFound` | No persisted snapshot for requested id. |
| `StagingUnavailable` | Opaque staged media/envelope reference cannot be opened. |
| `StorageIoFailure` | Local opaque storage read/write failed. |

R-C1 already owns `IdempotencyExpired`, `ManifestSetConflict`, and
`BackendIdempotencyConflict`; this SPEC must not propose alternate names for
those allocations.

## Shared illustrative DTOs

```rust
pub type EffectId = Uuid;
pub type JobId = String;
pub type SyncId = String;
pub type AlbumId = String;
pub type AssetId = String;
pub type Cursor = String;
pub type EpochId = u32;
pub type SnapshotRevision = u64;

pub trait CancellationToken: Send + Sync + Clone {
    fn is_cancelled(&self) -> bool;
    fn cancel(&self);
}

pub trait ProgressSink: Send + Sync {
    fn report(&self, bytes_uploaded: u64);
}

pub enum SnapshotKey {
    UploadJob(JobId),
    AlbumSync(AlbumId),
}

// Canonical projection for storage keys:
// SnapshotKey::UploadJob(id) => "upload-job:<id>"
// SnapshotKey::AlbumSync(id) => "album-sync:<id>"
// `<id>` is the canonical UUIDv7 string already carried by the reducer.

pub struct PortError {
    pub code: ClientErrorCode,
    pub redacted_message: String, // no caller-supplied strings
    pub retry: RetryPosture,
}

pub enum RetryPosture {
    NonRetryable,
    Retryable,
    OutcomeUnknown,
    ResumeFromPersistedOutput,
}

pub struct EpochHandle {
    pub handle_id: u64, // opaque Rust-owned handle id; no key bytes
}

pub struct StagedMediaRef {
    pub job_id: JobId,
    pub opaque_ref: String, // adapter-private token, not URI/path/name
}

pub struct StagedBlobRef {
    pub job_id: JobId,
    pub opaque_ref: String, // adapter-private staging token
    pub byte_len: u64,
}

pub struct EncryptedShardRef {
    pub tier: u8,
    pub shard_index: u32,
    pub shard_id: Option<String>,
    pub sha256: String,
    pub content_length: u64,
    pub envelope_version: u8,
    pub encrypted_blob: StagedBlobRef,
}

pub struct ManifestReceipt {
    pub manifest_id: String,
    pub metadata_version: u64,
}
```

`ProgressSink::report(bytes_uploaded)` is synchronous and bytes-only.
Implementations should throttle progress callbacks to at most 10 calls/second to
avoid main-thread spam; reducers never observe progress. Under back-pressure,
callbacks may be dropped, but the final callback before successful completion
must report the total uploaded byte count. The callback must not receive URLs,
filenames, retry counts, shard IDs, or any string payload.

## Port specifications

### 1. PrepareMediaPort

**Purpose:** Convert an opaque staged media reference into privacy-safe planned
tier/shard plaintext blobs for the encryption pipeline.

**DTO shape:**

```rust
pub trait PrepareMediaPort {
    async fn prepare_media(
        &self,
        input: PrepareMediaInput,
        cancel: CancellationToken,
    ) -> Result<PrepareMediaOutput, PortError>;
}

pub struct PrepareMediaInput {
    pub effect_id: EffectId,
    pub job_id: JobId,
    pub staged_media: StagedMediaRef,
    pub requested_album_id: AlbumId,
    pub now_ms: i64,
}

pub struct PrepareMediaOutput {
    pub planned_shards: Vec<PreparedShardPlan>,
    pub media_plan_hash: String,
}

pub struct PreparedShardPlan {
    pub tier: u8,
    pub shard_index: u32,
    pub plaintext: StagedBlobRef,
    pub plaintext_len: u64,
}
```

**Async behavior:** Async and cancellable. Web dispatches to existing tiered,
video, and legacy handlers behind the W-A1 adapter; Android dispatches to A6
`MediaTierGenerator` plus A7 `VideoFrameExtractor`. It is not idempotent by
itself because codec output can vary across platforms; it is
resume-from-persisted-output by persisting `media_plan_hash` and opaque staged
blob refs.

**Persistence transaction rules:** Does not run inside snapshot CAS. The host
persists adapter-private staging refs separately, then sends `MediaPrepared` to
the reducer and persists the resulting snapshot with CAS.

**Red-data constraints:** Input cannot contain content URI, file path, filename,
EXIF, GPS, device metadata, or MIME-derived names. Output cannot contain
plaintext metadata or raw media bytes in the reducer snapshot. Plaintext staged
blobs are platform-private and must be wiped by `CleanupStagingPort`.

**Conformance trace requirements:** Adapter tests replay the Q-final-1 media
fixture matrix and assert only privacy-safe plans cross the reducer boundary:
tier/index/length/hash/opaque-ref. Privacy scanners must inject sentinel
filenames, EXIF tokens, and GPS coordinates and prove they do not appear in DTO
serialization, logs, or diagnostics.

**Failure mapping:** Unsupported codec -> `UnsupportedMediaFormat`; malformed
container -> `InvalidMediaContainer`; invalid dimensions ->
`InvalidMediaDimensions`; output exceeds policy -> `MediaOutputTooLarge`;
metadata stripping mismatch -> `MediaMetadataMismatch`; deterministic-plan
mismatch -> `MediaAdapterOutputMismatch`; local staging failure ->
`StagingUnavailable`; cancellation -> `OperationCancelled`.

**iOS mapping:** Use `PHPickerResult` immediate app-private staging,
`AVAssetImageGenerator` for video posters, `CoreImage`/`ImageIO` for decode and
metadata stripping, and app-private file handles for `StagedBlobRef`.

### 2. EncryptShardPort

**Purpose:** Encrypt one planned plaintext shard with an opaque epoch handle and
return an encrypted shard reference for upload and manifest assembly.

**DTO shape:**

```rust
pub trait EncryptShardPort {
    async fn encrypt_shard(
        &self,
        input: EncryptShardInput,
        cancel: CancellationToken,
    ) -> Result<EncryptShardOutput, PortError>;
}

pub struct EncryptShardInput {
    pub effect_id: EffectId,
    pub job_id: JobId,
    pub epoch: EpochHandle,
    pub tier: u8,
    pub shard_index: u32,
    pub plaintext: StagedBlobRef,
    pub envelope_version: u8, // v1 production: 3
    pub now_ms: i64,
}

pub struct EncryptShardOutput {
    pub shard: EncryptedShardRef,
}
```

**Async behavior:** Async and cancellable. Web routes through
`rust-crypto-core.ts` and the crypto worker. Android routes through
`AndroidRustShardApi.encryptShardWithEpochHandle`. The port posture is
`ResumeFromPersistedOutput`: encrypting the same `(shard_id, plaintext)` twice
produces different ciphertext because fresh nonces are mandatory, so retries
must reuse the persisted encrypted blob from the first successful call.

**Persistence transaction rules:** Encryption does not run inside snapshot CAS.
The encrypted staged blob and `EncryptedShardRef` are persisted adapter-side
before the `ShardEncrypted` event is delivered; reducer snapshot CAS follows the
event.

**Red-data constraints:** Receives `EpochHandle`, never raw epoch/tier key bytes
per ADR-006, "Rules". Plaintext bytes may exist only in platform-private staging
and worker memory. Logs and errors must not include plaintext, handle IDs if
linkable, nonce bytes, or key material.

**Conformance trace requirements:** Cross-wrapper vectors assert native Rust,
WASM, and UniFFI produce valid envelope v3 bytes for the same deterministic test
inputs where test-mode randomness is explicitly supplied by the harness rather
than by the reducer. Negative vectors cover bad tier, stale epoch handle, and
cancellation. ADR-013
"API shape" vectors are separate and deferred for streaming v4.

**Failure mapping:** Missing/stale epoch -> `EpochHandleNotFound`; invalid tier
or envelope -> `InvalidEnvelope`; invalid input length -> `InvalidInputLength`;
authentication/encryption failure -> `AuthenticationFailed`; post-encrypt
self-verify digest mismatch -> `ShardIntegrityFailed`; staging read/write
failure -> `StorageIoFailure`; cancellation -> `OperationCancelled`.

**iOS mapping:** Use Swift/Objective-C bindings to the same Rust handle table;
plaintext and encrypted blobs stay in app-private temporary files protected by
Data Protection, with crypto work on a background `Task`.

### 3. CreateShardUploadPort

**Purpose:** Initialize a Tus upload session for one encrypted shard and return
the server upload URL plus stable shard id.

**DTO shape:**

```rust
pub trait CreateShardUploadPort {
    async fn create_shard_upload(
        &self,
        input: CreateShardUploadInput,
    ) -> Result<CreateShardUploadOutput, PortError>;
}

pub struct CreateShardUploadInput {
    pub effect_id: EffectId,
    pub job_id: JobId,
    pub album_id: AlbumId,
    pub idempotency_key: String,
    pub encrypted_shard: EncryptedShardRef,
    pub now_ms: i64,
}

pub struct CreateShardUploadOutput {
    pub upload_url: String,
    pub shard_id: String,
    pub tier: u8,
    pub shard_index: u32,
    pub sha256: String,
}
```

**Async behavior:** Async. It is idempotent for the same `idempotency_key` and
canonical encrypted-shard metadata. Web maps to existing `tus-upload.ts`;
Android maps to A5b `TusClientAdapter`. No cancellation token is required
because it is a short session-init call; transport timeout maps to a retryable
failure.

**Persistence transaction rules:** Must not run inside snapshot CAS. The Tus
session metadata, `upload_url`, and `shard_id` must be persisted before
delivering `ShardUploadCreated`; the reducer snapshot is then CAS-written.

**Red-data constraints:** Tus metadata may include opaque album id, shard id,
sha256, byte length, tier/index if required, and envelope version. It must not
include filenames, content URIs, plaintext media metadata, or key material.

**Conformance trace requirements:** HTTP/Tus mock fixtures replay duplicate
session init with identical idempotency key and canonical body, process-death
after response before event commit, and body mismatch. Adapter must recover by
loading persisted session output rather than creating a second session.

**Failure mapping:** Auth failure -> `TransportUnauthorized`; timeout or 5xx ->
`TransportUnavailable`/`TransportTimeout` retryable; malformed Tus response ->
`TransportBadResponse`; idempotency body mismatch -> `BackendIdempotencyConflict`;
expired idempotency cache -> `IdempotencyExpired`; local session persistence
failure -> `StorageIoFailure`.

**iOS mapping:** Use `URLSession` for Tus creation and SQLite/GRDB for durable
Tus session metadata.

### 4. UploadShardPort

**Purpose:** PATCH encrypted envelope bytes to an existing Tus session and report
privacy-safe byte progress.

**DTO shape:**

```rust
pub trait UploadShardPort {
    async fn upload_shard(
        &self,
        input: UploadShardInput,
        progress: ProgressSink,
        cancel: CancellationToken,
    ) -> Result<UploadShardOutput, PortError>;
}

pub struct UploadShardInput {
    pub effect_id: EffectId,
    pub job_id: JobId,
    pub upload_url: String,
    pub shard_id: String,
    pub encrypted_blob: StagedBlobRef,
    pub expected_sha256: String,
    pub expected_content_length: u64,
    pub now_ms: i64,
}

pub struct UploadProgress {
    pub uploaded_bytes: u64,
    pub total_bytes: u64,
}

pub struct UploadShardOutput {
    pub shard_id: String,
    pub tier: u8,
    pub shard_index: u32,
    pub sha256: String,
    pub content_length: u64,
}
```

**Async behavior:** Async, long-running, cancellable, retryable, and resumable.
Tus `HEAD`/offset state determines resume position. Progress emits byte counts
only; no names or IDs are sent to notification text or telemetry per ADR-018.

**Persistence transaction rules:** Tus offset/session metadata is platform-owned
and persisted during upload. Reducer snapshot CAS occurs only when the port
returns `ShardUploaded`. Partial upload cancellation or process death must leave
enough session metadata to resume or safely retry.

**Red-data constraints:** The port receives encrypted envelope bytes only. It
must not log URLs with query secrets, request bodies, response bodies, filenames,
plaintext metadata, or shard IDs in telemetry. Progress is bytes only.

**Conformance trace requirements:** Tus fixtures cover offset mismatch, 308
resume, network drop mid-PATCH, cancellation, process death, sha256 mismatch, and
duplicate completion replay. Notification/log scanners assert progress strings
contain only bytes/percentages.

**Failure mapping:** Offset/session conflict -> `TusSessionConflict`; timeout or
network outage -> `TransportTimeout`/`TransportUnavailable` retryable; malformed
Tus response -> `TransportBadResponse`; sha256 mismatch -> `InvalidEnvelope`;
local encrypted blob missing -> `StagingUnavailable`; cancellation ->
`OperationCancelled`.

**iOS mapping:** Use background-capable `URLSessionUploadTask` plus persisted
Tus offsets in GRDB; progress callbacks expose bytes only.

### 5. CreateManifestPort

**Purpose:** Commit the finalized encrypted manifest body to `/api/manifests`
with ADR-022 idempotency semantics.

**DTO shape:**

```rust
pub trait CreateManifestPort {
    async fn create_manifest(
        &self,
        input: CreateManifestInput,
    ) -> Result<CreateManifestResult, PortError>;
}

pub struct CreateManifestInput {
    pub effect_id: EffectId,
    pub job_id: JobId,
    pub album_id: AlbumId,
    pub idempotency_key: String,
    pub canonical_body: Vec<u8>, // canonical CBOR or JSON body bytes, no plaintext
    pub body_hash: String,
    pub now_ms: i64,
}

pub enum CreateManifestResult {
    Committed(ManifestReceipt),
    ManifestCommitOutcomeUnknown,
}
```

**Async behavior:** Async. Idempotent for identical
`Idempotency-Key` plus identical canonical body per ADR-022, "Rules" #11. A
transport failure after request dispatch returns `ManifestCommitOutcomeUnknown`
instead of retrying blindly. A definite pre-send failure is retryable.

**Persistence transaction rules:** The idempotency key and canonical body hash
must already be persisted in the upload snapshot per ADR-022, "Rules" #12 and
ADR-023. The port does not CAS-write snapshots; the reducer handles
`ManifestCreated` or `ManifestOutcomeUnknown`.

**Red-data constraints:** `canonical_body` contains only encrypted manifest
bytes, signatures, public keys, opaque IDs, tiered shard refs, hashes, lengths,
and protocol fields. No plaintext metadata, names, URIs, EXIF, GPS, or key bytes.
Errors must not echo body bytes or HTTP bodies.

**Conformance trace requirements:** Manifest mock fixtures cover: identical key
and identical canonical body returns identical `ManifestReceipt`; identical key
and different body returns `409 IDEMPOTENCY_CONFLICT`; malformed manifest body
returns `400 BAD_REQUEST`; cache eviction within TTL returns
`409 IDEMPOTENCY_KEY_EXPIRED`; transport drop after send returns
`ManifestCommitOutcomeUnknown`; sync recovery detects matching asset/shard set
and maps an `asset_id` match with a different `shard_set_hash` to
`ManifestSetConflict`.

**Failure mapping:** Success -> `Ok`; post-send unknown ->
`ClientCoreManifestOutcomeUnknown`; `400 BAD_REQUEST` ->
`ManifestShapeRejected`; `409 IDEMPOTENCY_CONFLICT` ->
`BackendIdempotencyConflict`; `409 IDEMPOTENCY_KEY_EXPIRED` ->
`IdempotencyExpired`; manifest-unknown recovery body mismatch where `asset_id`
matches but `shard_set_hash` differs -> `ManifestSetConflict`; auth failure ->
`TransportUnauthorized`; malformed response -> `TransportBadResponse`; definite
pre-send timeout -> `TransportTimeout` retryable.

**iOS mapping:** Use `URLSession` POST with `Idempotency-Key`; store the
idempotency key and body hash in GRDB before dispatch.

### 6. FetchAlbumSyncPagePort

**Purpose:** Fetch one encrypted album sync page from
`GET /api/albums/{id}/sync` without applying it.

**DTO shape:**

```rust
pub trait FetchAlbumSyncPagePort {
    async fn fetch_album_sync_page(
        &self,
        input: FetchAlbumSyncPageInput,
        cancel: CancellationToken,
    ) -> Result<FetchAlbumSyncPageOutput, PortError>;
}

pub struct FetchAlbumSyncPageInput {
    pub effect_id: EffectId,
    pub sync_id: SyncId,
    pub album_id: AlbumId,
    pub cursor: Option<Cursor>,
    pub now_ms: i64,
}

pub struct FetchAlbumSyncPageOutput {
    pub requested_cursor: Option<Cursor>,
    pub next_cursor: Option<Cursor>,
    pub reached_end: bool,
    pub encrypted_page: StagedBlobRef,
    pub encrypted_item_count: u32,
    pub page_hash: String,
}
```

**Async behavior:** Async, cancellable, and resume-from-persisted-output. If a
page has been fetched and durably staged but the `PageFetched` event was not
committed, the adapter reuses the staged page and page hash.

**Persistence transaction rules:** Does not apply items or advance the sync
cursor. The encrypted page is durably staged before `PageFetched`; reducer
snapshot CAS follows the event.

**Red-data constraints:** The page remains encrypted until apply. The port may
not emit decrypted item content, plaintext metadata, album names, filenames, or
IDs in telemetry. HTTP logs must omit URLs with cursor values if cursors become
linkable.

**Conformance trace requirements:** Fixtures cover empty cursor, non-empty
cursor, reached-end page, non-advancing cursor rejection by reducer, transport
drop, cancellation, and replay of persisted fetched page. The R-Cl2 atomic-apply
fixture must pair each fetch vector with an apply vector.

**Failure mapping:** Auth -> `TransportUnauthorized`; timeout/outage ->
`TransportTimeout`/`TransportUnavailable`; malformed page ->
`TransportBadResponse`; local staging failure -> `StorageIoFailure`;
cancellation -> `OperationCancelled`; non-advancing cursor is not mapped here
because the reducer maps it to `ClientCoreSyncPageDidNotAdvance`.

**iOS mapping:** Use `URLSession` GET and app-private encrypted page staging;
store page hash and cursor metadata in GRDB.

### 7. ApplyAlbumSyncPagePort

**Purpose:** Decrypt and apply a fetched sync page, advance cursor, and persist
the reducer snapshot as one atomic transaction.

**DTO shape:**

```rust
pub trait ApplyAlbumSyncPagePort {
    async fn apply_album_sync_page(
        &self,
        input: ApplyAlbumSyncPageInput,
        cancel: CancellationToken,
    ) -> Result<ApplyAlbumSyncPageOutput, PortError>;
}

pub struct ApplyAlbumSyncPageInput {
    pub effect_id: EffectId,
    pub sync_id: SyncId,
    pub album_id: AlbumId,
    pub epoch: EpochHandle,
    pub encrypted_page: StagedBlobRef,
    pub page_hash: String,
    pub cursor_to_apply: Option<Cursor>,
    pub expected_revision: SnapshotRevision,
    pub reducer_snapshot_after_page_applied: Vec<u8>,
    pub now_ms: i64,
}

pub struct ApplyAlbumSyncPageOutput {
    pub cursor: Option<Cursor>,
    pub page_hash: String,
    pub item_count: u32,
    pub new_revision: SnapshotRevision,
}
```

**Async behavior:** Async, cancellable before commit, and atomic. The port
decrypts using the supplied opaque `epoch: EpochHandle`; it must not reach into a
hidden global handle table based only on `album_id`. If the handle is expired or
invalid, the port returns `EpochHandleNotFound`; the reducer loop reacquires via
`AcquireEpochHandle` and transitions through `RetryWaiting` using the existing
state-machine vocabulary. Once the transaction commits, cancellation is ignored
and the adapter emits `PageApplied { cursor, page_hash, item_count }` to the
reducer loop bookkeeping; the reducer advances only after that event.

**Persistence transaction rules:** Must run inside one CAS transaction per
ADR-023, "Persistence transactions and CAS": decrypt page, validate it, write
the new snapshot CBOR, and advance the cursor in one transaction with
`expected_revision`. For v1, the cross-platform contract is snapshot-CBOR plus
cursor only. Platform-specific item-level caches, such as Android Room
`album_items` or a future web FTS5/OPFS index, are private adapter extensions
outside this port contract and must not affect parity tests. All contract writes
commit or none commit.

**Red-data constraints:** Decrypted page items are platform-local and must not
cross into logs, telemetry, HTTP, or reducer snapshots as plaintext. The snapshot
blob remains opaque CBOR. The port must not emit album/photo names, captions,
EXIF, GPS, or raw IDs into diagnostic events.

**Conformance trace requirements:** Atomicity fixtures inject failures at
decrypt, cursor write, snapshot CBOR write, and snapshot CAS. Tests assert no
partial cursor advance, no partial snapshot write, and `RevisionConflict` on
concurrent writer. Any item-level caching is platform-internal and does not
affect cross-platform parity tests. Replay vectors confirm duplicate `ApplyPage`
with same page hash is recognized through persisted transaction output. A
stale-epoch-handle fixture asserts `EpochHandleNotFound` triggers the
`AcquireEpochHandle`/`RetryWaiting` recovery path without applying the page.

**Failure mapping:** Expired/stale epoch handle -> `EpochHandleNotFound`; AEAD
tag or shard digest mismatch -> `ShardIntegrityFailed`; legacy raw-key fallback
success -> success plus `TelemetryPort` emission of
`LegacyRawKeyDecryptFallback`; non-shard authentication failure ->
`AuthenticationFailed`; invalid envelope/page -> `InvalidEnvelope`; CAS mismatch
-> `RevisionConflict`; snapshot schema too new ->
`ClientCoreUnsupportedSnapshotVersion`; corrupt snapshot ->
`ClientCoreInvalidSnapshot`; storage failure -> `StorageIoFailure`; cancellation
before commit -> `OperationCancelled`.

**iOS mapping:** Use Rust decrypt bindings plus GRDB transaction; local encrypted
cache writes, cursor update, and snapshot CAS occur in one database transaction.

### 8. ScheduleRetryPort

**Purpose:** Sleep until the reducer-supplied absolute retry timestamp and then
deliver `RetryTimerElapsed`.

**DTO shape:**

```rust
pub trait ScheduleRetryPort {
    async fn schedule_retry(
        &self,
        input: ScheduleRetryInput,
    ) -> Result<ScheduleRetryOutput, PortError>;
}

pub struct ScheduleRetryInput {
    pub effect_id: EffectId,
    pub machine_id: String, // job_id or sync_id
    pub not_before_ms: i64,
    pub target_phase: u8,
    pub attempt: u32,
    pub now_ms: i64,
}

pub struct ScheduleRetryOutput {
    pub fired_at_ms: i64,
}
```

**Async behavior:** Async but simple. The reducer owns due-time calculation; the
port only waits until `not_before_ms`. It must not add platform-specific
backoff, clamping, jitter, or retry math. If the platform cannot wake exactly at
the time, it wakes as soon as possible after the timestamp. The deduplication
key is exactly `effect_id`: two schedule calls with the same `effect_id` are
idempotent, and the second call is a no-op or replacement of the same record.
Hosts must persist scheduled wakeups keyed by `effect_id`. On process restart,
all wakeups whose `not_before_ms <= now_ms()` fire immediately in a documented
stable order, either `effect_id` lexicographic order or insertion order. Wakeups
whose `not_before_ms > now_ms()` are rescheduled for the remaining delta.
`fired_at_ms` is host-populated event metadata only and is never reducer input
for additional wall-clock decisions.

**Persistence transaction rules:** Schedule records are platform-owned and must
reference the persisted effect id. No snapshot CAS occurs inside the port; the
timer result is delivered as `RetryTimerElapsed` and reducer output is persisted
afterward.

**Red-data constraints:** Schedule records contain only machine id, effect id,
attempt, target phase, and timestamp. No filenames, metadata, keys, or body
bytes.

**Conformance trace requirements:** Deterministic clock fixtures assert no
platform backoff math is applied, past timestamps fire immediately, duplicate
effect ids do not create duplicate reducer events, and process restart restores
pending wakeups, past-due wakeups fire immediately after restart in the
platform's documented stable order, and future wakeups are rescheduled for the
remaining delta.

**Failure mapping:** Scheduler storage failure -> `StorageIoFailure`; cancelled
machine before wake -> `OperationCancelled`; invalid timestamp/effect record ->
`ClientCoreInvalidSnapshot`.

**iOS mapping:** Use `BGProcessingTask` or `BGTaskScheduler` for background
wakeups and an in-process `Task.sleep`/timer while foregrounded.

### 9. PersistSnapshotPort

**Purpose:** Persist an opaque reducer snapshot CBOR blob using ADR-023 compare
and swap.

**DTO shape:**

```rust
pub trait PersistSnapshotPort {
    async fn persist_snapshot(
        &self,
        input: PersistSnapshotInput,
    ) -> Result<PersistSnapshotOutput, PortError>;
}

pub struct PersistSnapshotInput {
    pub key: SnapshotKey,
    pub expected_revision: SnapshotRevision,
    pub snapshot_cbor: Vec<u8>,
    pub now_ms: i64,
}

pub struct PersistSnapshotOutput {
    pub new_revision: SnapshotRevision,
}
```

**Async behavior:** Async local I/O. Idempotent only for the same
`expected_revision` and identical `snapshot_cbor` when the previous write's
result is known; otherwise CAS conflict triggers reload/reconcile.

**Persistence transaction rules:** This is the CAS port. It uses the same `SnapshotKey` enum and canonical storage projection as `LoadSnapshotPort`. It must implement
ADR-023, "CAS write rule": write succeeds only when current
`snapshot_revision == expected_revision`; mismatch returns `RevisionConflict`.

**Red-data constraints:** The port treats bytes as opaque and does not parse or
log them. Snapshot bytes must already be validated by Rust to contain no raw
keys, plaintext media/metadata, raw URIs, or filenames per ADR-023, "Validation
rules at decode time".

**Conformance trace requirements:** Web IDB, Android Room, and iOS GRDB fixtures
load identical CBOR bytes, perform concurrent write races, and assert
`RevisionConflict` plus byte-equal final snapshots. Downgrade/too-new fixtures
come from ADR-023 migration tests.

**Failure mapping:** CAS mismatch -> `RevisionConflict`; storage unavailable ->
`StorageIoFailure`; unsupported snapshot -> `ClientCoreUnsupportedSnapshotVersion`;
invalid/corrupt snapshot -> `ClientCoreInvalidSnapshot`.

**iOS mapping:** Store opaque CBOR in GRDB with a revision column and a single
`UPDATE ... WHERE revision = expected_revision` transaction.

### 10. LoadSnapshotPort

**Purpose:** Load opaque snapshot CBOR bytes for a job or album sync machine.

**DTO shape:**

```rust
pub trait LoadSnapshotPort {
    async fn load_snapshot(
        &self,
        input: LoadSnapshotInput,
    ) -> Result<LoadSnapshotOutput, PortError>;
}

pub struct LoadSnapshotInput {
    pub key: SnapshotKey,
}

pub struct LoadSnapshotOutput {
    pub snapshot_cbor: Vec<u8>,
    pub revision: SnapshotRevision,
}
```

**Async behavior:** Async local I/O. Resume-from-persisted-output. Reducer or
Rust migration code parses the bytes; the port remains opaque.

**Persistence transaction rules:** Read transaction must return snapshot bytes
and revision from the same committed state. No CAS write occurs.

**Red-data constraints:** Must not parse or log snapshot bytes. The key is an
opaque job or album id and must not be emitted in telemetry.

**Conformance trace requirements:** Fixtures cover missing snapshot, current
schema load, too-new schema, corrupt CBOR, and byte-equal load across IDB/Room
/GRDB. Adapter must prove no field-level schema is duplicated in platform code.

**Failure mapping:** Missing row -> `SnapshotNotFound`; storage failure ->
`StorageIoFailure`; schema too new after Rust parse ->
`ClientCoreUnsupportedSnapshotVersion`; corrupt bytes after Rust parse ->
`ClientCoreInvalidSnapshot`.

**iOS mapping:** Load the opaque CBOR BLOB and revision from GRDB without
inspecting fields in Swift.

### 11. CancelPort

**Purpose:** Convert a user/platform cancellation request into a reducer
`CancelRequested` event for the relevant upload or sync machine.

**DTO shape:**

```rust
pub trait CancelPort {
    async fn cancel(
        &self,
        input: CancelInput,
    ) -> Result<CancelOutput, PortError>;
}

pub enum CancelTarget {
    UploadJob(JobId),
    AlbumSync(SyncId),
}

pub struct CancelInput {
    pub target: CancelTarget,
}

pub struct CancelOutput {
    pub delivered: bool,
}
```

**Async behavior:** Async only because it may coordinate workers. It must be
idempotent: repeated cancel requests for the same machine deliver at most one
effective `CancelRequested` into a non-terminal reducer state.

**Persistence transaction rules:** The cancel request is recorded platform-side,
in-flight cooperative tokens are signaled, then the reducer event is applied and
persisted with CAS. The port itself does not mutate snapshots.

**Red-data constraints:** Cancel DTOs contain only the target job/sync
identifier. They must not include media names, notification text, reason strings
from the user, timestamps, or HTTP bodies.

**Conformance trace requirements:** State-machine replay vectors cover
pre-manifest hard cancel, post-manifest `ManifestCommitUnknown`, sync cancel,
duplicate cancel, and process death while cancellation is pending.

**Failure mapping:** Already terminal or no-op cancel -> `Ok` with
`delivered = false`; cancellation delivered -> `Ok`; missing snapshot ->
`SnapshotNotFound`; CAS conflict during event persistence -> `RevisionConflict`;
worker cancellation failure that still leaves snapshot consistent ->
`OperationCancelled`.

**iOS mapping:** Cancel foreground `Task`s and background `URLSessionTask`s,
record the request in GRDB, and route only `CancelRequested` to Rust.

### 12. CleanupStagingPort

**Purpose:** Wipe staged plaintext, encrypted shard logical records, and Tus
session metadata when a machine reaches a terminal phase.

**DTO shape:**

```rust
pub trait CleanupStagingPort {
    async fn cleanup_staging(
        &self,
        input: CleanupStagingInput,
    ) -> Result<CleanupStagingOutput, PortError>;
}

pub enum TerminalReason {
    Confirmed,
    Cancelled,
    Failed,
}

pub struct CleanupStagingInput {
    pub job_id: JobId,
    pub reason: TerminalReason,
}

pub struct CleanupStagingOutput {
    pub wiped_plaintext_record_count: u32,
    pub wiped_encrypted_record_count: u32,
    pub removed_tus_session_record_count: u32,
}
```

**Async behavior:** Async local I/O. Idempotent: missing logical staging or
session records count as already cleaned. Triggered by `Confirmed`, `Cancelled`,
or `Failed` terminal phases.

**Persistence transaction rules:** Cleanup does not run inside reducer snapshot
CAS. The terminal snapshot must be persisted before cleanup starts, so cleanup
failure does not regress reducer state. On `Confirmed` or `Cancelled`, cleanup
wipes staging records and may remove the snapshot row. On `Failed`, cleanup
wipes staging records only and must preserve the snapshot row plus
`Idempotency-Key` for ADR-022's 30-day TTL window so manifest-unknown recovery
can replay the same key if the user retries from a fresh upload job that shares
the same `asset_id`.

**Red-data constraints:** Cleanup logs and telemetry may include logical record
counts only. A logical record is a platform-private staging entry, not
necessarily a filesystem file; web IDB blobs, Android files plus Room rows, and
iOS GRDB/file pairs all report the same logical categories. No file paths,
filenames, URI fragments, content hashes, shard ids, or plaintext bytes.

**Conformance trace requirements:** Fixtures create plaintext staging,
encrypted staging, and Tus session rows, then assert idempotent wipe after each
terminal reason. The idempotency-key-survives-cleanup-after-Failed fixture
asserts manifest recovery remains viable for the ADR-022 30-day TTL window.
Privacy scanners verify cleanup diagnostics contain logical counts only.

**Failure mapping:** Local wipe failure -> `StorageIoFailure`; invalid terminal
reason or non-terminal invocation -> `ClientCoreInvalidTransition`; repeated
cleanup -> `Ok`.

**iOS mapping:** Use app-private file deletion plus Data Protection-aware
background cleanup through `BGProcessingTask`; store cleanup markers in GRDB.

### 13. EpochHandleAcquirePort

**Purpose:** Mint an opaque epoch handle for upload encryption or sync-page
decryption without moving raw epoch key material across a port boundary.

**DTO shape:**

```rust
pub trait EpochHandleAcquirePort {
    async fn acquire_epoch_handle(
        &self,
        input: AcquireEpochHandleInput,
    ) -> Result<AcquireEpochHandleOutput, PortError>;
}

pub struct AcquireEpochHandleInput {
    pub album_id: AlbumId,
    pub epoch_id: EpochId,
}

pub struct AcquireEpochHandleOutput {
    pub handle: EpochHandle,
}
```

**Async behavior:** Async because it may consult platform-private identity or
epoch-key stores. The port wraps existing Rust crypto-handle APIs that mint
handles inside the ADR-006 secret registry; no raw epoch, tier, identity, or
account key bytes cross the port. Handles may expire on logout, registry reset,
process death, or explicit close.

**Persistence transaction rules:** Does not run inside snapshot CAS. The host
delivers `EpochHandleAcquired` or the corresponding port error to the reducer
loop, then persists reducer output with CAS. Handles are not persisted in
snapshots; snapshots persist only epoch identifiers and reducer state.

**Red-data constraints:** Inputs contain only opaque album and epoch identifiers.
Outputs contain only `EpochHandle`. Errors and telemetry must not include handle
IDs if linkable, wrapped keys, raw key bytes, identity material, or album names.

**Conformance trace requirements:** Fixtures cover normal acquisition, logout or
registry reset causing `EpochHandleNotFound`, missing identity handle,
cancellation of surrounding state-machine work, and stale handles consumed by
`EncryptShardPort` or `ApplyAlbumSyncPagePort`. Web, Android, and iOS adapters
must use the same handle-table API shape.

**Failure mapping:** Missing epoch material -> `EpochHandleNotFound`; missing
identity handle required to unwrap epoch material -> `IdentityHandleNotFound`;
operation cancelled by surrounding reducer flow -> `OperationCancelled`; secret
registry poisoning/panic -> `InternalStatePoisoned`.

**iOS mapping:** Use the same opaque Rust handle-table API as web and Android.
Swift stores only the returned handle id in memory for the active reducer loop
and never persists raw key bytes or handle internals.

### 14. ClockPort

**Purpose:** Provide platform time so hosts can populate event payloads without
reducers reading time.

**DTO shape:**

```rust
pub trait ClockPort {
    fn now_ms(&self) -> i64;
}
```

**Async behavior:** Synchronous, idempotent in the sense that it has no side
effects. Tests may inject a deterministic clock.

**Persistence transaction rules:** None. The returned value is copied into
events or port inputs by the host.

**Red-data constraints:** Time must not be precise telemetry tied to user
actions. Diagnostic events use buckets per ADR-018, not raw per-action
timestamps.

**Conformance trace requirements:** Reducer tests use a fake clock to prove
events carry `now_ms`, reducers never call time, and retry due-time math remains
inside the reducer/host input path defined by plan §0.4.

**Failure mapping:** No runtime failure. Invalid platform clock state in tests
maps to `ClientCoreInvalidSnapshot` only if it creates invalid persisted data.

**iOS mapping:** Use `Date().timeIntervalSince1970` converted to milliseconds in
the host adapter; inject a deterministic clock in tests.

### 15. TelemetryPort

**Purpose:** Append a privacy-safe `DiagnosticEvent` to the local diagnostic ring
buffer.

**DTO shape:**

```rust
pub trait TelemetryPort {
    async fn emit_diagnostic(
        &self,
        event: DiagnosticEvent,
    ) -> Result<(), PortError>;
}

pub struct DiagnosticEvent {
    pub code: ClientErrorCode,
    pub phase: u8,
    pub retry_count: u8,
    pub elapsed_bucket_ms: u32,
    pub schema_version: u16,
    pub correlation_id: [u8; 16], // opaque session-local nonce, not an ID
}
```

**Async behavior:** Async local I/O. Best-effort: telemetry failure must never
change reducer state or retry behavior. `schema_version: u16` is a forever-
frozen append-only diagnostic-event registry surface per plan §13; the registry
and lock test are a follow-up ticket before telemetry adapter implementation. No
server delivery occurs in this port; ADR-018's opted-in aggregate upload is a
separate out-of-band diagnostics port.

**Persistence transaction rules:** Writes to a bounded local ring buffer only
(last 1000 web events; last 5000 Android events per ADR-018, "What is collected
(locally first)"). It is not part of snapshot CAS.

**Red-data constraints:** Must follow ADR-018, "What is never collected": no
user content, filenames, captions, EXIF, GPS, device metadata, account/session
/handle identifiers, album/photo/manifest/shard IDs, IP augmentation, precise
timestamps, crash payload bodies, headers, URLs, or variable values.

**Conformance trace requirements:** Privacy fixtures emit each port failure with
sentinel PII in surrounding inputs and assert ring-buffer serialization contains
only code, phase, retry count, elapsed bucket, schema version, and session-local
opaque 16-byte correlation nonce. Logout wipe tests clear the buffer.

**Failure mapping:** Ring-buffer write failure -> `StorageIoFailure` but caller
must swallow it after local debug handling. Invalid event shape and red-data
detection are conformance failures before runtime dispatch, not reducer-visible
errors.

**iOS mapping:** Store bounded local diagnostic events in GRDB or an app-private
ring-buffer file; aggregate upload remains outside this port.

## Conformance matrix

Every adapter must pass the following fixture classes before it is considered a
valid implementation:

| Fixture class | Ports covered | Required proof |
| --- | --- | --- |
| Cross-platform fixture matrix Q-final-1 | Prepare/encrypt/manifest/sync | Deterministic outputs where byte-equality is required; documented codec divergence only where ADR-014 permits it. |
| Reducer replay vectors | All effect-driven ports | Process death between effect completion and event commit does not duplicate irreversible work. |
| Privacy sentinel scan | All ports | No filenames, EXIF, GPS, raw URIs, plaintext metadata, keys, body bytes, or IDs appear in DTO debug strings, logs, telemetry, Room, IDB, or GRDB. |
| CAS race vectors | Persist/load/apply/cancel | Concurrent writers return `RevisionConflict` and reconcile by reload. |
| Transport fault matrix | HTTP/Tus ports | 401/403, 408/timeout, 409 idempotency conflict/expired, 5xx, malformed response, and network drop map to the specified `ClientErrorCode`. |
| Cancellation matrix | Long-running ports | Cooperative cancellation leaves snapshots and staging consistent; cancel-mid-flight and future-drop-without-signal cases are covered. |
| Panic-firewall matrix | All ports | Injected implementation panic returns `InternalStatePoisoned` with `<panic redacted>`, zeroizes plaintext-bearing buffers in scope, and leaves the worker usable. |
| Epoch-handle freshness | Encrypt/apply/acquire | Stale handles return `EpochHandleNotFound`; reducer reacquires through `AcquireEpochHandle` and `RetryWaiting` without applying or encrypting with hidden keys. |
| Cleanup/idempotency TTL | Cleanup/manifest recovery | Cleanup after `Failed` wipes staging only and preserves snapshot plus `Idempotency-Key` for ADR-022's 30-day recovery window. |
| iOS stub compile checklist Q-final-2 | All ports | Swift/Objective-C adapter can implement every DTO and trait shape without changing Rust core. |

## Future ports

These surfaces are anticipated but are not required for the v1 upload/sync
state-machine effect boundary defined here:

- `IdentityHandleAcquirePort`: if identity acquisition becomes a reducer effect
  rather than a host precondition, it must use opaque handles under ADR-006.
- `DiagnosticsAggregateUploadPort`: ADR-018's opted-in weekly aggregate upload
  is deliberately out of band from upload/sync reducers.
- `StreamingEncryptShardPort`: ADR-013 freezes the v4 API shape but defers
  production streaming AEAD to v1.x.
- `SecretStorePort`: OS/browser restore-blob storage exists under ADR-004's
  initial port taxonomy but is not part of the upload/sync reducer effects in
  this SPEC.
- `NotificationProgressPort`: Android/iOS user-visible progress presentation is
  UI shell behavior. If standardized later, it must preserve the bytes-only
  progress rule.

No v1 upload/sync port required by W-A1, W-A2, W-A3, A4/A5b/A8/A9/A10/A11/A13,
or Q-final-2 is deferred from this SPEC; the v1 set is exactly the 15 ports
specified above.
