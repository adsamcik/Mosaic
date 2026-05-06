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

## Contract tests

The co-located Vitest tests exercise the same contract Android receives through
the generated UniFFI bridge shapes: initialize a snapshot, advance with a known
event, and verify non-zero Rust error codes propagate. Cross-platform parity
tests should compare these port DTO names and event names against the Android
`ClientCore*` bridge records.
