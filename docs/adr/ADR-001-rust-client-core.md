# ADR-001: Adopt a Rust client core with web and Android adapter frontends

## Status

Accepted

## Context

Mosaic is a zero-knowledge image sharing application. The existing browser client owns cryptography, upload orchestration, manifest assembly, sync coordination, local state, and media preparation. Android support would otherwise require duplicating those protocol rules in Kotlin or weakening the zero-knowledge boundary through server-side import behavior.

The app is unreleased, so the client architecture can change cleanly. The primary product goal remains simple encrypted image sharing, not an architecture migration for its own sake.

## Decision

Mosaic will move security-critical client behavior into a shared Rust client core consumed by:

- the web app through a WASM worker facade, and
- the Android app through a UniFFI/JNI facade.

The target Rust crates are:

- `mosaic-domain`: canonical domain types, schema versions, identifiers, canonical byte encoding, and stable error codes.
- `mosaic-crypto`: key hierarchy, envelope encryption, signing, verification, key wrapping, secret handle storage, zeroization, and golden-vector execution.
- `mosaic-client`: upload, sync, session, sharing, and capability state machines using ports for platform effects.
- `mosaic-media`: gated media pipeline, separate from the crypto/domain/client core.
- `mosaic-wasm`: WASM facade for browser workers.
- `mosaic-uniffi`: Android facade.

The web and Android applications remain responsible for UI, permissions, platform storage, HTTP execution, rendering, lifecycle, notifications, and platform-specific media access.

## Options Considered

### Keep browser TypeScript as canonical and port to Kotlin

- Pros: least disruption to the current web app; fastest short-term Android prototype.
- Cons: duplicates crypto/protocol logic; creates divergent implementations; increases risk of nonce, manifest, serialization, and error-handling drift.
- Conviction: 3/10.

### Move only crypto primitives to Rust

- Pros: reduces the highest-risk duplicate crypto code; smaller first migration.
- Cons: upload/sync/manifest state machines still diverge between web and Android; platform shells can still reimplement protocol rules incorrectly.
- Conviction: 6/10.

### Move crypto, domain contracts, and core state machines to Rust

- Pros: one canonical implementation for security-sensitive behavior; both clients share protocol tests and vectors; platform shells stay thin.
- Cons: more tooling complexity; WASM/UniFFI build risks must be retired early.
- Conviction: 9/10.

## Consequences

- Rust becomes the source of truth for Mosaic protocol behavior after the cross-client vector/interoperability gates pass.
- Existing TypeScript crypto remains temporarily as a reference and rollback path, not the long-term canonical implementation.
- Any platform-specific implementation of crypto or protocol rules must be treated as a temporary adapter bridge and removed once the Rust path is validated.
- The migration proceeds through vertical slices: Rust/FFI build spike, Android one-photo upload, web WASM feature flag, then broader client-core orchestration.

## Reversibility

Phased. Before production traffic uses Rust crypto, the web app can keep the current TypeScript path. After Rust-backed uploads are interoperable across web and Android, rollback remains source-level because the app is unreleased and no persistent compatibility guarantee is required.
