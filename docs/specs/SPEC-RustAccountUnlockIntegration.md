# Rust Account Unlock Integration

## Scope

This slice adds Android-first Rust client-core account unlock integration.

Included:

- unwrap an existing wrapped L2 account key from password bytes, user salt, account salt, and KDF profile parameters;
- store the unwrapped L2 account key in Rust-owned opaque handle storage;
- return only a stable error code and opaque account-key handle;
- expose UniFFI facade functions for Android account unlock, account-key handle status, and account-key handle close;
- preserve identity-handle workflows that create/open identities from an account-key handle and cascade-close identity handles when the account handle closes.

Excluded:

- new cryptographic primitives or alternate KDF/wrapping implementations;
- backend, web, WASM, or Android app scaffolding;
- account registration UX or server authentication flow changes;
- persistent storage of passwords, raw account keys, identity seeds, or plaintext metadata.

## Data Flow

```text
password bytes + user_salt(16) + account_salt(16)
  + wrapped_account_key + KDF profile(memory_kib, iterations, parallelism)
  -> mosaic_client::unlock_account_key(request)
     -> Zeroizing password copy
     -> mosaic_crypto::KdfProfile::new(...)
     -> mosaic_crypto::unwrap_account_key(...)
        -> Argon2id(password, user_salt, profile) = L0
        -> HKDF-SHA256(L0, account_salt, "mosaic:root-key:v1") = L1
        -> XChaCha20-Poly1305 unwrap wrapped_account_key with L1 = L2
     -> open Rust-owned account-key handle backed by zeroizing secret registry
     -> zeroize caller password buffer and temporary keys
     -> AccountUnlockResult { code, handle }

account key handle
  -> create_identity_handle(account_key_handle)
     -> random identity seed
     -> wrapped seed encrypted by L2
     -> identity handle stores Rust-owned signing material

close_account_key_handle(account_key_handle)
  -> close and wipe L2 account key
  -> cascade close linked identity handles
```

The client-core request accepts the password as a mutable buffer so the API can wipe caller-owned bytes on both success and failure. The UniFFI facade deliberately passes password bytes as a function argument rather than putting them in a UniFFI `Record`, because UniFFI records derive debug/clone-style traits for generated bindings and must not carry raw secrets.

Platform callers still own their pre-FFI password buffers. Android/Kotlin integration must wipe the caller-side `ByteArray` in a `finally` block after `unlockAccountKey` returns, because Rust can only zeroize the copies it owns or receives across the UniFFI boundary.

## Zero-Knowledge and FFI Invariants

- The server receives no password bytes, L0/L1/L2 keys, identity seeds, plaintext photos, or plaintext metadata.
- `mosaic-client` returns only stable error codes and opaque handle identifiers for account unlock.
- Raw account key bytes never cross public FFI results and are never logged.
- Password bytes are zeroized in client-core on every exit path where the API owns or can mutate the buffer.
- Existing `mosaic_crypto::unwrap_account_key` remains the only unwrap implementation for this slice; no new crypto is introduced.
- Public secret-bearing types must not implement `Debug`, `Clone`, `Copy`, `Display`, or serialization.
- UniFFI secret inputs must not be represented as debug/clone records; non-secret salts, KDF parameters, and encrypted wrapped key bytes may be represented as records.
- Closing an account-key handle closes and wipes any linked identity handles.

## Component Tree

```text
crates/mosaic-client
  src/lib.rs
    AccountUnlockRequest<'_>
    AccountUnlockResult
    unlock_account_key
    account_key_handle_is_open
    close_account_key_handle
    existing secret handle registry reuse
    existing identity cascade reuse
  tests/account_unlock.rs
    account unlock lifecycle, identity workflow, error mapping, zeroization

crates/mosaic-uniffi
  src/lib.rs
    AccountUnlockRequest (non-secret parameters)
    AccountUnlockResult
    AccountKeyHandleStatusResult
    unlock_account_key(password_bytes, request)
    account_key_handle_is_open(handle)
    close_account_key_handle(handle)
  tests/ffi_snapshot.rs
    stable API snapshot and account unlock error/result mapping

docs/specs/SPEC-RustAccountUnlockIntegration.md
  this spec
```

## Verification Plan

TDD:

1. Add `crates/mosaic-client/tests/account_unlock.rs`.
2. Add UniFFI account-unlock assertions to `crates/mosaic-uniffi/tests/ffi_snapshot.rs`.
3. Run `cargo test -p mosaic-client --test account_unlock --locked` and confirm RED from missing API.
4. Implement the client-core unlock facade using existing crypto and handle registries.
5. Implement the UniFFI Android facade and update the stable snapshot string.
6. Re-run focused tests and then the full Rust verification gate.

Required tests:

- account unlock returns an opaque handle, exposes no raw account key bytes, reports open status, and closes cleanly;
- returned account handle can create an identity handle and sign/verify a manifest transcript;
- closing an account handle cascades and invalidates linked identity handles;
- wrong password and tampered wrapped account key map to `AuthenticationFailed` with handle `0`;
- weak KDF profile maps to `KdfProfileTooWeak` with handle `0`;
- invalid user-salt and account-salt lengths map to `InvalidSaltLength` with handle `0`;
- password input buffers are zeroized by the client unlock API on success and failure;
- UniFFI snapshot includes account unlock, account-key handle status, and account-key close;
- UniFFI unlock returns stable codes and opaque handles only.

Final gate:

1. `cargo fmt --all --check`
2. `cargo test -p mosaic-crypto --locked`
3. `cargo test -p mosaic-client --locked`
4. `cargo test -p mosaic-uniffi --locked`
5. `cargo clippy --workspace --all-targets --all-features -- -D warnings`
6. `cargo deny check`
7. `cargo vet`
8. `.\scripts\rust-check.ps1` if time permits
9. `git --no-pager diff --check`

Focused review:

- security review for zero-knowledge boundaries, password zeroization, secret-handle lifecycle, error-code stability, and absence of secret-bearing debug/clone records.
