# ADR-005: Prefer audited pure-Rust crypto dependencies for the Rust core

## Status

Accepted

## Context

The current web crypto implementation uses libsodium through WebAssembly bindings. The Rust client core must support native Rust tests, WASM workers, Android arm64, Android emulator x86_64, deterministic test vectors, dependency audits, and reproducible builds.

The migration does not need to preserve unreleased encrypted data compatibility, but it must preserve Mosaic's zero-knowledge invariants and pass cross-client vectors.

## Decision

Mosaic will prefer audited pure-Rust crypto crates for the Rust core:

- `argon2` for Argon2id password hashing.
- `hkdf` + `sha2` for HKDF-SHA256 key expansion.
- `chacha20poly1305` for XChaCha20-Poly1305 AEAD.
- `ed25519-dalek` for Ed25519 signatures.
- `crypto_box` or an equivalent reviewed Rust implementation for X25519 sealed-box style key distribution when needed.
- `rand_core`/`getrandom` for OS CSPRNG integration.
- `zeroize` and opaque secret wrappers for memory hygiene.
- `subtle` for constant-time comparisons where comparisons are required.

Bindings to libsodium or other native libraries are allowed only if a spike proves a pure-Rust option cannot meet required correctness, portability, performance, maintenance, or security needs.

## Options Considered

### Continue libsodium as the canonical implementation through Rust bindings

- Pros: aligns with current browser behavior; mature primitive set.
- Cons: native dependency complexity for Android/WASM; harder reproducible builds; larger binary/linker surface; FFI boundary around C memory.
- Conviction: 6/10.

### Use pure-Rust crates as the primary implementation

- Pros: simpler cross-compilation; Rust-native memory/trait integration; easier fuzzing and cargo supply-chain checks; no C ABI for core crypto.
- Cons: must verify crate maturity and constant-time behavior; output can differ from libsodium for nonstandard derivation currently used in TypeScript.
- Conviction: 8/10.

### Keep both implementations permanently

- Pros: fallback options.
- Cons: doubles audit and vector burden; increases risk of behavior drift.
- Conviction: 2/10.

## Consequences

- The Rust implementation defines the v1 crypto profiles through vectors, not by implicit libsodium compatibility.
- `cargo deny`, `cargo audit`, and an explicit dependency review gate are required before production use.
- KDF and serialization changes must produce positive and negative vectors.
- Any native dependency exception requires a follow-up ADR that documents why pure Rust failed and how the native supply-chain risk is contained.

## Reversibility

Phased. The FFI/build spike can still switch a specific primitive to libsodium/native bindings before production crypto porting begins. After Rust vectors become canonical, changing primitive crates requires a protocol/vector migration ADR.
