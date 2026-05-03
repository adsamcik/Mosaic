# ADR-023: Persisted snapshot schema strategy (D8)

## Status

Accepted. Governs the design of `R-Cl3` (snapshot schema versioning + migration vectors) and the Room/IDB schemas in A2b / W-A2.

## Context

The Rust core completion programme introduces persisted client-state in two new locations:

- **Web (IndexedDB):** `UploadJobSnapshot` (`mosaic-upload-jobs` store) and `AlbumSyncSnapshot` (`mosaic-album-sync` store), persisted by W-A2 and W-A3 respectively as part of the `RustUploadAdapter` / `RustSyncAdapter` rollout.
- **Android (Room):** `upload_job_snapshots` and `album_sync_snapshots` tables, persisted by A2b once Rust DTOs finalize (R-Cl1, R-Cl2, R-Cl3).

The 3-reviewer pass (`files/reviews/R1-gpt55-workstreams.md`, `R2-gpt55-technical.md`, `R3-opus47-coherence.md`) flagged that snapshot schema is a **forever-frozen, durable artifact** the moment a single user persists one. v1 plan v1 said only "schema_version mirrors Rust" without specifying the wire format, migration policy, phase enum representation, or rejection rules. That gap creates four concrete failure modes:

1. Rust adds a snapshot field; Room/IDB readers crash or silently drop the field.
2. Rust changes a phase enum numeric value; old persisted jobs map to wrong state.
3. Web and Android serialize the same logical snapshot to different bytes; cross-platform parity tests pass but actual user data diverges.
4. A user updates from version N to N+2; the snapshot from N has a schema unknown to N+2, and there is no migration path.

This ADR defines the durable persistence contract for client-state snapshots so that R-Cl3, A2b, W-A2 / W-A3 share one source of truth.

## Decision

### Single canonical wire format: CBOR canonical encoding via `ciborium`

Snapshots are serialized as **CBOR canonical encoding** (RFC 8949 §4.2.1) for both IndexedDB and Room. This is byte-equal across platforms for identical logical snapshots and is the same format Rust uses for `canonical_manifest_transcript_bytes`-style operations.

**Encoder crate (locked).** `ciborium` (latest pinned version) is the canonical encoder. WASM and UniFFI both go through Rust → same crate → byte-equal output. Tests assert byte-equal serialization across native Rust, WASM, and UniFFI for the cross-platform fixture matrix (Q-final-1).

**Map key encoding (locked).** Snapshot maps use **integer keys** (CBOR major type 0/1), *not* string keys. Integer keys sort by their numeric value under canonical encoding, which is independent of the field's English-language name and avoids the "first map key" ambiguity that plagues string-keyed CBOR canonicalization.

The `schema_version` field is allocated **integer key `0`**, guaranteeing it is the first map key in any canonical encoding. Other top-level fields are allocated stable integer keys per a registry maintained alongside the snapshot type definitions:

```rust
// crates/mosaic-client/src/snapshot_schema.rs (illustrative; locked by lock test)
const KEY_SCHEMA_VERSION: u32 = 0;       // u16 inside; first map key under canonical sort
const KEY_JOB_ID: u32 = 1;               // UUIDv7 bytes
const KEY_ALBUM_ID: u32 = 2;
const KEY_PHASE: u32 = 3;                // u8, see phase enum allocation below
const KEY_RETRY_COUNT: u32 = 4;          // u8
const KEY_MAX_RETRY_COUNT: u32 = 5;      // u8
const KEY_NEXT_RETRY_NOT_BEFORE_MS: u32 = 6;  // i64 (absolute, reducer-supplied)
const KEY_IDEMPOTENCY_KEY: u32 = 7;      // UUIDv7 bytes
const KEY_TIERED_SHARDS: u32 = 8;        // array of canonical CBOR maps per ADR-022
const KEY_SHARD_SET_HASH: u32 = 9;       // 32 bytes
const KEY_SNAPSHOT_REVISION: u32 = 10;   // u64, monotonic; explicit u64 to avoid wrap
const KEY_LAST_ACKNOWLEDGED_EFFECT_ID: u32 = 11;  // UUIDv7 bytes; was KEY_LAST_EFFECT_ID; renamed pre-freeze
const KEY_LAST_APPLIED_EVENT_ID: u32 = 12;        // R-Cl1 split for replay-dedup
const KEY_FAILURE_CODE: u32 = 13;                 // R-Cl1 added
// ... keys 14..=127 reserved for v1; 128+ for future schema versions
```

The integer-key registry is governed identically to the sidecar tag registry (ADR-017): append-only, lock-tested, ADR-changeable. New keys take the next available value; deprecated keys retain their numeric position.

**Schema evolution note (R-Cl1).** Key `11` was renamed from `KEY_LAST_EFFECT_ID` to `KEY_LAST_ACKNOWLEDGED_EFFECT_ID` before the v1 freeze. The wire byte remains the integer-key slot `11`; only the semantics narrowed to the effect acknowledgement watermark. Replay deduplication moved to its own append-only key `12` (`KEY_LAST_APPLIED_EVENT_ID`), and terminal failure persistence uses key `13` (`KEY_FAILURE_CODE`). Keys `14..=127` remain reserved for v1 append-only growth.

**Forbidden field types.** The snapshot encoder rejects:
- `f32` / `f64` floating-point (canonicalization is unstable for NaN payloads),
- maps with non-integer keys (forces the integer-key registry discipline),
- nested arbitrary-precision integers (CBOR major type 6 tag 2/3) — bounded integers only.

This makes the encoded bytes deterministic across all sane producers; Q-final-1 byte-equality tests are tractable.

**Storage layout.**
- IDB stores the CBOR bytes in a single column; the IDB key is the snapshot's `job_id` / `album_id`.
- Room stores the CBOR bytes in a `BLOB` column under a `snapshot_blob` field; primary key is the snapshot's `job_id` / `album_id`.
- Neither platform parses field-level columns. Persistence is opaque-blob-only; reducer parsing is the only source of truth.

This deliberately rules out per-field SQL columns or IDB indices, because:
- Field-level decomposition fragments schema across two persistence layers (IDB + Room) that would drift.
- Reducer purity (R-Cl1 / R-Cl2) means the snapshot is consumed as a whole; field-level access is unnecessary for the upload/sync flow.
- Storage layout becomes an implementation detail of the persistence layer; the wire format is the contract.

### `schema_version: u16` is the single migration coordinate

Both `UploadJobSnapshot` and `AlbumSyncSnapshot` carry a `schema_version: u16` field as the first map key in the canonical CBOR. v1 ships with `schema_version = 1`. Migrations are implemented in Rust (`mosaic-client/src/snapshot_migrate.rs`) as pure functions:

```rust
pub fn upgrade_upload_job_snapshot(bytes: &[u8]) -> Result<UploadJobSnapshot, MigrationError>;
pub fn upgrade_album_sync_snapshot(bytes: &[u8]) -> Result<AlbumSyncSnapshot, MigrationError>;
```

Both functions:
1. Decode the CBOR bytes.
2. Read the `schema_version` field.
3. Apply migration steps `from_v(N) -> from_v(N+1) -> ... -> from_v(CURRENT)` in sequence.
4. Return the upgraded in-memory struct.

If `schema_version > CURRENT` (downgrade case), the reducer returns `MigrationError::SchemaTooNew`. Adapters must surface this as user-visible "client out of date — please update" and refuse to advance the state machine. **Downgrades are not supported.**

If `schema_version` is unknown to the migration function (e.g. a deprecated branch), `MigrationError::SchemaUnsupported` is returned and the snapshot is treated as orphaned (recoverable via cleanup, not via continued use).

### Phase enum representation: numeric `u8` with append-only allocation

`UploadJobPhase` and `AlbumSyncPhase` are serialized as `u8` numeric values, *not* string names. Numeric allocations are append-only and snapshotted by the lock test (`mosaic-client/tests/phase_enum_lock.rs`).

- v1 reserves `UploadJobPhase`: `Queued = 0`, `AwaitingPreparedMedia = 1`, `AwaitingEpochHandle = 2`, `EncryptingShard = 3`, `CreatingShardUpload = 4`, `UploadingShard = 5`, `CreatingManifest = 6`, `ManifestCommitUnknown = 7`, `AwaitingSyncConfirmation = 8`, `RetryWaiting = 9`, `Confirmed = 10`, `Cancelled = 11`, `Failed = 12`.
- v1 reserves `AlbumSyncPhase`: `Idle = 0`, `FetchingPage = 1`, `ApplyingPage = 2`, `RetryWaiting = 3`, `Completed = 4`, `Cancelled = 5`, `Failed = 6`.
- New phases are added with the next available numeric value.
- The two enums are **type-distinct**; their numeric overlap (both start at 0) is irrelevant inside their respective snapshot types because each snapshot type carries only one of the two enums. Cross-tooling that inspects raw values must include the snapshot-type discriminator. Inspection helpers that combine both enums (e.g. an Android Studio plugin) are forbidden from sharing one global enum.
- Reading an unknown numeric value from a persisted snapshot returns `MigrationError::SchemaTooNew` only when `schema_version` itself is unknown; if `schema_version` is current but the numeric phase value is out of range for that schema, return `MigrationError::SchemaCorrupt` (distinct error class, distinct user-visible posture).

### Validation rules at decode time

Every snapshot decode validates:

1. `schema_version <= CURRENT`.
2. Phase numeric value is in the allocated set for that schema version.
3. `retry_count <= max_retry_count <= MAX_RETRY_COUNT_LIMIT (64)`.
4. `effect_id` (when present) is a valid UUIDv7.
5. `snapshot_revision` is monotonically non-decreasing across reads of the same snapshot (CAS guarantee).
6. No raw key bytes, no plaintext media bytes, no raw URIs, no file names — these classes are excluded by type at struct-definition time, but the decode validator also rejects any CBOR map with forbidden field names as a defense-in-depth check.

### Persistence transactions and CAS

- **CAS write rule:** `update_snapshot(job_id, expected_revision, new_bytes)` succeeds only if the current persisted `snapshot_revision == expected_revision`. On mismatch, returns `RevisionConflict` and the reducer reconciles by re-reading.
- **Atomic apply for sync:** `ApplyPagePort` is a single transaction — decrypt + apply items + advance cursor + persist snapshot — or none. Per R-Cl2.
- IDB: implemented via versioned `IDBObjectStore` + explicit `IDBTransaction.objectStore("snapshots")` reads/writes inside `readwrite` transactions.
- Room: implemented via `@Transaction`-annotated DAO methods.

### Migration test obligations (per R-Cl3)

For every schema version bump:
1. A vector of v(N) snapshot bytes is checked into `crates/mosaic-client/tests/fixtures/snapshots/`.
2. A v(N) → v(N+1) migration test asserts the upgraded struct.
3. A v(N) → v(CURRENT) migration test asserts cumulative correctness.
4. A v(N+1) (or newer) → v(N) downgrade test asserts `SchemaTooNew`.
5. Web vitest and Android instrumented test load the same fixture bytes, run the same Rust migration via WASM and UniFFI, and assert byte-equal upgraded bytes.

## Options Considered

### Per-field SQL columns / IDB indices

- Pros: queryable; partial reads; selective updates.
- Cons: schema drift between IDB and Room; doubles migration burden; reducer doesn't need partial reads (snapshot is consumed whole); breaks the single-source-of-truth invariant.
- Conviction: 2/10.

### JSON encoding of snapshot bytes

- Pros: human-readable in DB inspectors.
- Cons: not byte-equal across platforms (key ordering, whitespace, number representation); larger; slower; no canonical form; would require a custom canonicalizer.
- Conviction: 3/10.

### CBOR canonical encoding (this decision)

- Pros: byte-equal across platforms for identical inputs; binary-efficient; native Rust support; spec'd canonical form (RFC 8949 §4.2.1); same posture as `canonical_*` Rust functions.
- Cons: not human-readable; requires a debug viewer for ad-hoc inspection.
- Conviction: 9/10.

### Protobuf-encoded snapshots

- Pros: similar properties to CBOR; well-tooled.
- Cons: introduces a `prost` / schema-compiler dependency; another supply-chain vector; less canonical (multiple valid encodings); we already canonicalize on CBOR for transcript bytes.
- Conviction: 5/10.

### String phase enums

- Pros: human-readable.
- Cons: append-only string sets are easier to fork; typos silently divergent; takes more bytes; locked-test discipline weaker.
- Conviction: 3/10.

## Consequences

- R-Cl3 implements the migration framework, lock tests, and fixture corpus per the rules above.
- A2b (Android Room snapshot schema) stores opaque CBOR `BLOB` per snapshot keyed by `(job_id|album_id)`; uses `@Transaction` for CAS write; surfaces `RevisionConflict` to caller.
- W-A2 / W-A3 (web IDB) use versioned IDB stores with the same opaque-blob discipline; `IDBTransaction` for CAS.
- New SPEC `docs/specs/SPEC-ClientCoreSnapshotSchema.md` documents the wire format, migration coordinate, phase numeric allocations, and validation rules.
- New lock test `mosaic-client/tests/phase_enum_lock.rs` mirrors `error_code_table.rs`.
- Q-final-1 cross-wrapper digest-scope vector includes snapshot CBOR byte-equality between native Rust, WASM, and UniFFI for the fixture matrix.
- Performance budget Q-final-4 includes a snapshot decode budget (≤ 5 ms p95 on Android mid-tier; ≤ 1 ms p95 on web Chromium).
- Backward-incompatible changes to either snapshot type require a new ADR + schema_version bump + migration vectors.

## Reversibility

Low. CBOR canonical encoding, `schema_version` numeric, phase enum allocations, and validation rules are all forever-frozen the moment v1 ships and a single user persists a snapshot. The migration framework is reversible (new versions can be added) but the v1 layout itself cannot be retroactively changed.
