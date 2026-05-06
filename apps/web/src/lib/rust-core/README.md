# Rust core adapter ports

This directory defines web-side ports for the Rust client-core upload and
album-sync state machines.

## Pattern

- `upload-adapter-port.ts` owns the TypeScript DTOs and interfaces consumed by
  W-A2/W-A3.
- `wasm-upload-adapter-port.ts` owns the WASM-backed implementations. The
  classes receive generated `mosaic_wasm` bindings from their composition root,
  call the primitive exports, parse the JSON proof surface, and translate
  non-zero Rust error codes into `RustCoreAdapterPortError`.

The generated WASM surface currently returns compact snapshot summaries for
`initUploadJob`, `advanceUploadJob`, `initAlbumSync`, and `advanceAlbumSync`.
The web port preserves adapter-owned fields needed for the next primitive call
and does not synthesize effects that the primitive surface does not expose.

## Consumers

W-A2 should inject `UploadAdapterPort` into the upload adapter. W-A3 should
inject `SyncAdapterPort` into the sync adapter. Production wiring supplies the
generated WASM init function plus state-machine exports to `WasmUploadAdapterPort`
and `WasmSyncAdapterPort`; tests can inject fake port implementations or fake
WASM bindings.

## Business-logic adapters

`RustUploadAdapter` and `RustSyncAdapter` are thin stateful layers over the
ports. They require an injected port because the WASM-backed ports need generated
bindings from the composition root. Both adapters persist snapshots after each
state transition and return pending effects as data; they do not dispatch HTTP,
IndexedDB, worker, or other state-machine side effects. `resume(snapshotId)`
returns `null` when no persisted snapshot exists; when it does load a snapshot,
it sets the adapter's current snapshot and re-surfaces any pending effect from
that snapshot.

`IdbUploadSnapshotPersistence` stores records in the legacy upload queue database
(`mosaic-upload-queue`, `tasks`) with `id`, `schemaVersion`, `snapshotVersion`,
`jobId`, `albumId`, `idempotencyKey`, `status`, `retryCount`, and
`rustCoreSnapshot` fields so the record shape remains compatible with the
existing queue drainer/current-record side.

## Contract tests

The co-located Vitest tests exercise the same contract Android receives through
the generated UniFFI bridge shapes: initialize a snapshot, advance with a known
event, and verify non-zero Rust error codes propagate. Cross-platform parity
tests should compare these port DTO names and event names against the Android
`ClientCore*` bridge records.
