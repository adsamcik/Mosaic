# Rust Epoch/Tier Keys

## Data flow

This slice stays inside the Rust client core and does not add server-visible fields or platform FFI exports.

Inputs:

```text
epoch_id: u32
epoch_seed: 32 random bytes
shard_tier: ShardTier::{Thumbnail, Preview, Original}
```

Outputs:

```text
EpochKeyMaterial {
  epoch_id: u32,
  epoch_seed: SecretKey,
  thumb_key: SecretKey,
  preview_key: SecretKey,
  full_key: SecretKey,
  content_key: SecretKey,
}
```

Tier lookup returns a borrowed `SecretKey` for the selected shard tier. Shard encryption continues to receive only a `SecretKey` and the existing header fields.

## ZK invariants

- Backend never receives plaintext epoch seeds, tier keys, content keys, or signing keys.
- This slice only derives Rust-owned in-memory keys. No key bytes cross WASM, JNI, UniFFI, JavaScript, or Kotlin boundaries.
- The epoch seed is generated with `getrandom`, moved into `SecretKey`, and the caller buffer is zeroized.
- Derived keys are `SecretKey` values and inherit the existing no-`Clone`, no-`Debug`, no-serialization, zeroizing behavior.
- Tests must not use equality assertions that print real key material on failure.

## Derivation

Rust v1 uses canonical HKDF-SHA256, not legacy TypeScript BLAKE2b/generichash behavior.

```text
IKM  = epoch_seed
salt = all-zero SHA-256 salt (RFC 5869 default salt)
L    = 32 bytes

thumb_key   = HKDF-SHA256(IKM, info = "mosaic:tier:thumb:v1")
preview_key = HKDF-SHA256(IKM, info = "mosaic:tier:preview:v1")
full_key    = HKDF-SHA256(IKM, info = "mosaic:tier:full:v1")
content_key = HKDF-SHA256(IKM, info = "mosaic:tier:content:v1")
```

The labels intentionally match the TypeScript tier labels so product vocabulary remains stable while the algorithm becomes canonical Rust v1 HKDF-SHA256.

## Component tree

```text
crates/mosaic-crypto
  src/lib.rs
    EpochKeyMaterial
    generate_epoch_key_material
    derive_epoch_key_material
    derive_content_key
    get_tier_key
  tests/epoch_keys.rs
    RED/GREEN tests for deterministic vectors, domain separation,
    invalid lengths, source zeroization, random generation, and tier lookup
```

No `mosaic-domain`, backend, web, Android, WASM, or UniFFI changes are part of this slice.

## Verification plan

1. `cargo test -p mosaic-crypto --test epoch_keys --locked` fails before implementation and passes after.
2. `cargo test -p mosaic-crypto --locked` passes.
3. `cargo clippy --workspace --all-targets --all-features -- -D warnings` passes.
4. `cargo deny check` passes.
5. `cargo vet` passes.
6. `.\scripts\rust-check.ps1` passes.
7. `.\scripts\build-rust-wasm.ps1` passes.
8. `.\scripts\build-rust-android.ps1` passes.
9. `git --no-pager diff --check` passes.

