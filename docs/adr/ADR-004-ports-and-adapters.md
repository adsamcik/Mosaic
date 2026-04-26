# ADR-004: Use ports and adapters around platform capabilities

## Status

Accepted

## Context

The Rust client core must run under very different platform constraints:

- browsers provide WASM workers, IndexedDB/OPFS, Fetch, Web Crypto integration points, and page lifecycle events,
- Android provides Kotlin, Android Keystore, Photo Picker, MediaStore, WorkManager, app-private storage, notifications, and process death/restart semantics.

Embedding platform APIs directly in Rust core crates would make the core hard to test and difficult to run consistently on both clients.

## Decision

Rust core crates use ports for platform effects and keep platform adapters in the web/Android shells or FFI crates.

Initial ports:

- `TransportPort`: authenticated HTTP/Tus operations and retry classification.
- `LocalStorePort`: encrypted local state, queue records, vector cache, and sync cursors.
- `SecretStorePort`: OS/browser-backed encrypted restore blobs and capability persistence.
- `MediaPort`: media bytes, tier generation, metadata extraction/stripping policy, and source-original archival.
- `ClockPort`: UTC time for expiry/session checks and test determinism.
- `RandomPort`: deterministic test randomness only; production crypto randomness is generated inside `mosaic-crypto`.
- `LogPort`: structured redacted logging.
- `BackgroundPort`: Android WorkManager/browser lifecycle coordination and cancellation.

Core crates depend inward only:

- `mosaic-domain` has no crypto/client/media/FFI dependencies.
- `mosaic-crypto` depends on domain and approved crypto dependencies, not platform adapters.
- `mosaic-client` depends on domain/crypto and port traits.
- FFI crates depend on core crates and adapt to platform shells.

## Options Considered

### Platform shells call low-level Rust crypto directly

- Pros: simpler FFI at first.
- Cons: platform code still owns protocol orchestration and can diverge.
- Conviction: 4/10.

### Rust core imports platform APIs directly

- Pros: fewer adapter interfaces.
- Cons: poor portability and testability; Android/browser dependencies leak inward.
- Conviction: 3/10.

### Hexagonal ports/adapters

- Pros: deterministic testing, clear boundaries, easier Android/web parity, supports worktree parallelism.
- Cons: more upfront interface design.
- Conviction: 9/10.

## Consequences

- Architecture tests must reject outward dependencies from core crates.
- Production `RandomPort` must not supply keys, nonces, salts, signing randomness, or share-link secrets.
- Media behavior is controlled through `MediaPort` leakage and metadata policies even if platform-native media processing remains in use.
- Backend API shape changes should update `TransportPort` tests rather than spread protocol decisions across UI code.

## Reversibility

Low-cost for individual ports. If a port proves too abstract or too narrow, change the Rust trait and update the web/Android adapters before the late v1 stabilization phase.
