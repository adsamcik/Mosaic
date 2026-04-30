# Cross-Platform Crypto Golden Vectors

## Status

Locked at v1. Implemented in `cc207b5` (`test(crypto): add cross-platform
golden vectors`) and expanded into a full corpus in `c7ba68b`
(`feat(crypto): add cross-client golden vector corpus`). The corpus lives
under `tests/vectors/` and covers `account_unlock`, `auth_challenge`,
`auth_keypair`, `content_encrypt`, `epoch_derive`, `identity`, `link_keys`,
`link_secret`, `manifest_transcript`, `sealed_bundle`, `shard_envelope`, and
`tier_key_wrap`. Cross-impl parity gaps were closed in `f8b0165`
(`fix(crypto): close cross-impl parity gaps for tier keys and manifest
transcript`) and `0e2957a` (Slice 0C `ts_canonical` primitives).

## Scope

This slice adds a narrow golden-vector runner for Rust canonical crypto/domain outputs that must remain identical across native Rust, Android UniFFI, and Web WASM facades.

Included:

- deterministic shard envelope header bytes and parsed public header fields;
- deterministic manifest transcript bytes for the existing canonical transcript format;
- deterministic identity public-key and signature vector from a private test-only seed;
- native `mosaic-client` snapshot plus UniFFI/WASM facade snapshots that return only public bytes and stable error codes.

Excluded:

- changing crypto algorithms, transcript formats, envelope layout, KDF parameters, or key wrapping;
- media generation, upload pipeline, backend APIs, Android app code, or web worker cutover;
- returning raw passwords, account keys, identity seeds, or other secret bytes from any runner;
- full FFI wrapper cutover tests for every crypto operation.

## Data Flow

```text
mosaic-domain golden_vectors
  -> envelope_header_bytes()
     -> fixed ShardEnvelopeHeader.to_bytes()
  -> manifest_transcript_bytes()
     -> fixed ManifestTranscript -> canonical_manifest_transcript_bytes()

mosaic-crypto golden_vectors
  -> identity_public_vector()
     -> private test-only identity seed
     -> derive_identity_keypair(seed)
     -> sign fixed transcript bytes
     -> return public signing key, public recipient key, and detached signature

mosaic-client
  -> crypto_domain_golden_vector_snapshot()
     -> aggregate domain + crypto public vector outputs
     -> code = stable ClientErrorCode

mosaic-uniffi / mosaic-wasm
  -> crypto_domain_golden_vector_snapshot()
     -> map native client snapshot to FFI-safe record/classes
```

## Zero-Knowledge Invariants

- Golden-vector runners never return raw secret bytes, passwords, account keys, identity seeds, L0/L1/L2 keys, or plaintext photo metadata.
- The identity seed used by the identity vector is a private, fixed, test-only input. It is copied into zeroizing key material, wiped after derivation, and never exposed through native or FFI outputs.
- Returned bytes are public protocol metadata: envelope header bytes, nonce bytes already present in the public header, canonical manifest transcript bytes containing encrypted metadata bytes only, public keys, and detached signatures.
- FFI records use stable numeric error codes and plain byte vectors only; no secret-bearing record derives `Debug`, `Clone`, or serialization traits.
- The slice introduces no logging, network I/O, persistence, or dependency changes.

## Component Tree

```text
crates/mosaic-domain
  src/lib.rs
    golden_vectors::{envelope_header_bytes, manifest_transcript_bytes}
  tests/golden_vectors.rs
    fixed envelope and manifest vectors

crates/mosaic-crypto
  src/lib.rs
    golden_vectors::identity_public_vector
  tests/golden_vectors.rs
    fixed public-key/signature vector, seed wipe proof

crates/mosaic-client
  src/lib.rs
    CryptoDomainGoldenVectorSnapshot
    crypto_domain_golden_vector_snapshot()
  tests/golden_vectors.rs
    native snapshot matches domain/crypto outputs

crates/mosaic-uniffi
  src/lib.rs
    CryptoDomainGoldenVectorSnapshot record
    crypto_domain_golden_vector_snapshot()
  tests/ffi_snapshot.rs
    UniFFI snapshot matches native client output

crates/mosaic-wasm
  src/lib.rs
    CryptoDomainGoldenVectorSnapshot and JS wrapper
    crypto_domain_golden_vector_snapshot()
  tests/ffi_snapshot.rs
    WASM Rust-side snapshot matches native client output
```

## Verification Plan

TDD:

1. Add domain golden-vector tests and confirm RED from missing `golden_vectors` helpers.
2. Implement the domain helpers and confirm the focused domain vector test is GREEN.
3. Add crypto/client/UniFFI/WASM snapshot tests and confirm RED from missing snapshot APIs.
4. Implement the native and wrapper snapshot APIs without changing existing crypto algorithms.
5. Run the requested Rust quality gate.

Required checks:

- `cargo fmt --all --check`
- `cargo test -p mosaic-domain --locked`
- `cargo test -p mosaic-crypto --locked`
- `cargo test -p mosaic-client --locked`
- `cargo test -p mosaic-uniffi --locked`
- `cargo test -p mosaic-wasm --locked`
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- `cargo deny check`
- `cargo vet`
- `.\scripts\rust-check.ps1`
- `.\scripts\build-rust-wasm.ps1`
- `.\scripts\build-rust-android.ps1`
- `git --no-pager diff --check`

