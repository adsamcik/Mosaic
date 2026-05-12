# SPEC: AEAD Domain Separation Registry

## Status

Implemented by R-C6 and extended by R-C4 streaming shard AEAD.

## Data flow

All affected wire blobs keep the existing `nonce(24) || ciphertext || tag(16)`
layout. The domain label is not serialized; it is an AEAD AAD input selected by
the wrapping API:

| Blob class | Producer | Consumer | Domain label usage |
| --- | --- | --- | --- |
| L3 epoch seed persisted as `wrappedEpochSeed` / `wrapped_epoch_seed` | Rust client epoch-handle creation and bundle import | Rust client epoch-handle open | `mosaic:l3-epoch-seed:v1` |
| L3 identity seed persisted as `wrappedSeed` / `wrapped_seed` | Rust client identity-handle creation | Rust client identity-handle open | `mosaic:l3-identity-seed:v1` |
| Generic OPFS/account data wrapped through account handles | `wrapWithAccountHandle` / `wrap_with_account_handle` | `unwrapWithAccountHandle` / `unwrap_with_account_handle` | `mosaic:account-wrapped-data:v1` |
| v0x04 streaming shard frame | Rust/Android streaming shard encryptor | Rust/Android streaming shard decryptor | `mosaic:stream-frame:v1` as frame-level AEAD AAD prefix |
| v0x04 streaming shard frame key | Rust/Android streaming shard encryptor | Rust/Android streaming shard decryptor | `mosaic:stream-frame-key:v1` as HKDF `info` prefix for per-frame key derivation |

## Zero-knowledge invariants

- L3 epoch and identity seed plaintext remains Rust-owned and never crosses the
  normal WASM/UniFFI output boundary.
- Generic account-data unwrap is no longer composable with seed ciphertexts:
  passing a seed wrap to the generic account-data unwrap uses the wrong AAD and
  returns `AuthenticationFailed` with an empty byte vector.
- The server still receives only opaque ciphertext blobs and public keys.
- Streaming labels are local crypto domain separators only. They are never
  serialized as plaintext metadata sent to the server.

## Component tree

- `crates/mosaic-crypto` defines the frozen labels, AAD-aware wrap helpers, and
  v0x04 streaming frame AAD / HKDF info labels.
- `crates/mosaic-client` assigns L3 seed wraps and generic account-data wraps to
  their dedicated labels.
- `apps/web/src/workers/db.worker.ts` bumps `SNAPSHOT_VERSION` from 3 to 4 so
  empty-AAD OPFS snapshots are discarded and repopulated.
- Architecture guard scripts reject future unreviewed wrap/unwrap FFI exports
  in the account/epoch/identity/link handle families.

## Verification plan

- `crates/mosaic-crypto/tests/envelope_crypto.rs::aad_secret_wrap_round_trips_only_with_matching_domain`
  proves matching AAD succeeds and wrong/empty AAD fails.
- `crates/mosaic-crypto/tests/kdf_and_auth_label_lock.rs::stream_frame_aad_label_is_frozen`
  pins `mosaic:stream-frame:v1`.
- `crates/mosaic-crypto/tests/kdf_and_auth_label_lock.rs::stream_frame_key_aad_label_is_frozen`
  pins `mosaic:stream-frame-key:v1`.
- `crates/mosaic-client/tests/adr006_compositional_attack_blocked.rs` proves the
  original epoch-seed and identity-seed attack chains now fail and that genuine
  account-data wrap/unwrap still round-trips.
- `apps/web/tests/db-worker-snapshot-version.test.ts` pins OPFS snapshot v4.
- `tests/architecture/no-raw-secret-ffi-export.ps1` and `.sh` catch new
  unallowlisted wrap/unwrap handle exports.
