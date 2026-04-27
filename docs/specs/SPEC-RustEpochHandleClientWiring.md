# Rust Epoch Handle Client Wiring

## Scope

This approved slice wires Rust-owned opaque epoch-key handles through the native client core, UniFFI, and WASM facade so Android and web clients can encrypt and decrypt shard tiers without raw epoch seeds, tier keys, content keys, account keys, passwords, identity seeds, or plaintext metadata sidecar keys crossing FFI/WASM.

Included:

- create/open/close/status lifecycle APIs for opaque `u64` epoch-key handles;
- account-linked epoch handle registries with account-close cascade behavior matching identity handles;
- shard encrypt/decrypt wrappers that select Rust-owned tier keys from an epoch handle;
- encrypted wrapped epoch seed output on create, and wrapped-seed input on open;
- UniFFI and WASM facade records/functions for the same stable client surface;
- native, UniFFI, and WASM snapshot/lifecycle tests.

Excluded:

- caller-supplied production nonce APIs;
- raw epoch seed, tier key, content key, or account-key exports;
- backend, filesystem, network, logging, dependency, or Android app UI changes.

## Data Flow

```text
create_epoch_key_handle(account_key_handle, epoch_id)
  -> load Rust-owned account key from opaque account handle
  -> mosaic_crypto::generate_epoch_key_material(epoch_id)
     -> random 32-byte epoch seed
     -> derive Rust-owned thumbnail/preview/original/content keys
  -> mosaic_crypto::wrap_key(epoch_seed, account_key)
  -> store EpochKeyMaterial in Rust registry under opaque u64
  -> EpochKeyHandleResult { code, handle, epoch_id, wrapped_epoch_seed }
```

`wrapped_epoch_seed` is encrypted with the L2 account key and is safe to persist/distribute anywhere the existing wrapped identity seed is safe. It is the only epoch-seed representation returned across FFI/WASM.

```text
open_epoch_key_handle(wrapped_epoch_seed, account_key_handle, epoch_id)
  -> load Rust-owned account key from opaque account handle
  -> mosaic_crypto::unwrap_key(wrapped_epoch_seed, account_key)
  -> mosaic_crypto::derive_epoch_key_material(epoch_id, unwrapped_seed)
  -> store EpochKeyMaterial under opaque u64
  -> EpochKeyHandleResult { code, handle, epoch_id, wrapped_epoch_seed: [] }
```

```text
encrypt_shard_with_epoch_handle(handle, plaintext, shard_index, tier_byte)
  -> validate tier_byte with ShardTier::try_from
  -> look up open EpochKeyMaterial
  -> mosaic_crypto::get_tier_key(material, tier)
  -> mosaic_crypto::encrypt_shard(plaintext, tier_key, epoch_id, shard_index, tier)
     -> internally generates a fresh random XChaCha20 nonce
  -> EncryptedShardResult { code, envelope_bytes, sha256 }
```

```text
decrypt_shard_with_epoch_handle(handle, envelope_bytes)
  -> look up open EpochKeyMaterial
  -> parse public 64-byte header to select tier and validate epoch_id
  -> mosaic_crypto::get_tier_key(material, header.tier)
  -> mosaic_crypto::decrypt_shard(envelope_bytes, tier_key)
  -> DecryptedShardResult { code, plaintext }
```

`plaintext` in `DecryptedShardResult` is client-local media bytes needed for display/download. It is returned only after successful local decryption and is always empty on error.

## Zero-Knowledge and FFI Invariants

- Server-visible APIs and storage never receive plaintext epoch seeds, account keys, tier keys, content keys, identity seeds, passwords, or plaintext metadata sidecar keys.
- Raw epoch seeds and derived keys stay in `mosaic_crypto::EpochKeyMaterial` behind Rust-owned opaque `u64` handles.
- `wrapped_epoch_seed` is encrypted with the account key and is the only epoch-seed artifact allowed to cross FFI/WASM.
- Account unlock remains the only password bootstrap path. Rust-owned password buffers are wiped by the existing account unlock path; platform callers still must wipe their original buffers.
- Production shard encryption uses `mosaic_crypto::encrypt_shard` so nonce generation remains internal and random.
- Error records use stable `ClientErrorCode` mappings and return empty byte/string fields on error.
- Closing an account handle marks the account closed, cascades linked identity and epoch handles, rolls back the account open bit if cascade lock acquisition fails, and only then removes/zeroizes the account key.
- No logging, filesystem, network, unsafe code, or new dependencies are introduced.

## Component Tree

```text
crates/mosaic-client
  src/lib.rs
    EpochKeyHandleResult / EpochKeyHandleStatusResult
    EncryptedShardResult / DecryptedShardResult
    epoch registry linked to account handles
    create/open/status/close epoch handle APIs
    encrypt/decrypt shard APIs using Rust-owned tier keys
    account close cascade across identity + epoch handles
  tests/epoch_handles.rs
    lifecycle, cascade, round trip, invalid tier, tamper, closed/missing handle tests

crates/mosaic-uniffi
  src/lib.rs
    UniFFI records/functions mirroring client epoch APIs
    bumped API snapshot
  tests/ffi_snapshot.rs
    stable snapshot and epoch facade behavior/error-code assertions

crates/mosaic-wasm
  src/lib.rs
    Rust-side facade records/functions
    wasm_bindgen JS result classes and exports
    account unlock/status/close facade if absent
    bumped API snapshot
  tests/ffi_snapshot.rs
    stable snapshot, account unlock, and epoch facade assertions
```

## Verification Plan

1. Add failing native tests in `crates/mosaic-client/tests/epoch_handles.rs` for lifecycle/status/close, open from wrapped seed, account-close cascade, encrypt/decrypt round trip, wrong/tampered envelopes, invalid tier, closed/missing handles, and empty outputs on errors.
2. Extend UniFFI and WASM snapshot tests for new account/epoch facade APIs and stable error codes.
3. Implement client-core registry/results/APIs using `generate_epoch_key_material`, `derive_epoch_key_material`, `get_tier_key`, `encrypt_shard`, `decrypt_shard`, `wrap_key`, and `unwrap_key`.
4. Implement UniFFI and WASM wrappers without exposing raw key material.
5. Run:
   - `cargo fmt --all --check`
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
