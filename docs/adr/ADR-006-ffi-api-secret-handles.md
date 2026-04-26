# ADR-006: Expose Rust through handle-based WASM and UniFFI APIs

## Status

Accepted

## Context

Mosaic must expose Rust functionality to JavaScript/Web Workers and Kotlin/Android without leaking raw cryptographic secrets across FFI boundaries. Both platforms have different object lifetime, memory-copying, cancellation, and error-reporting behavior.

The FFI layer must be stable enough for parallel web and Android worktrees while still allowing pre-release API evolution.

## Decision

`mosaic-wasm` and `mosaic-uniffi` expose high-level operations and opaque handles instead of raw key material.

Core exported object types:

- `InteractiveSessionHandle`: user-present crypto-unlocked session for browsing, decrypting, sharing, and manual upload.
- `AlbumUploadCapabilityHandle`: least-privilege capability for uploading to a specific album/epoch.
- `BackgroundImportCapabilityHandle`: Android-only, upload-only, device-credential-wrapped capability for future auto-import.
- `OperationHandle`: cancellable long-running operation with progress callbacks or polling.

Rules:

- Raw L0/L1/L2/epoch/signing/link keys do not cross JS/Kotlin/UniFFI boundaries during normal operations.
- Bootstrap inputs can include password/passphrase bytes and encrypted restore blobs; Rust immediately derives or unwraps internal secrets and wipes temporary buffers.
- Non-secret bytes such as encrypted envelopes, encrypted manifests, hashes, public keys, signatures, and opaque IDs may cross FFI.
- Every exported function has a documented secret-boundary classification.
- Errors map to stable domain error codes with redacted messages.
- Long-running calls expose cancellation and progress through wrapper-specific APIs.
- Wrapper API snapshots are tested for both generated TypeScript declarations and UniFFI Kotlin signatures.

## Options Considered

### Pass raw keys through FFI and let platform shells cache them

- Pros: simplest wrapper code.
- Cons: high leakage risk; platform logs/debuggers/GC can retain secrets; hard to enforce zeroization.
- Conviction: 1/10.

### Expose only stateless Rust functions

- Pros: easy to reason about individual calls.
- Cons: repeatedly crosses secrets through FFI; poor fit for session/capability expiry.
- Conviction: 4/10.

### Rust-owned handle table and high-level operations

- Pros: keeps secrets in Rust-owned memory; supports expiry and capability separation; stable for both WASM and Android.
- Cons: needs careful lifecycle and stale-handle error handling.
- Conviction: 9/10.

## Consequences

- Handle expiry is enforced by Rust core, not only UI timers.
- A server-authenticated app state is distinct from a crypto-unlocked state.
- When interactive handles expire, clients must clear decrypted in-memory gallery metadata/thumbnails and return to locked UI.
- Background upload capability cannot browse/decrypt the gallery or act as interactive unlock.
- Test suites must assert no FFI-exported function returns raw secret bytes unless explicitly allowlisted.

## Reversibility

Medium. Handle naming and method grouping can evolve before late v1 stabilization, but the no-raw-secret FFI rule is a permanent security invariant.
