# Rust Identity Handles

## Scope

This slice adds Rust-owned identity seed handling and opaque identity handles for the client-core upload path.

Included:

- derive Ed25519 identity signing and X25519 recipient public key material from a 32-byte identity seed;
- generate and wrap a fresh identity seed with an existing Rust-owned account-key handle;
- reopen a wrapped identity seed with an account-key handle;
- sign manifest transcript bytes through an opaque identity handle;
- expose stable UniFFI and WASM facade shapes for identity handle operations.

Excluded:

- password/account unlock FFI entry points;
- sealed-box encryption/decryption of epoch bundles;
- backend API changes;
- web or Android wrapper cutover;
- persistent local storage of wrapped identity seeds.

## Data Flow

```text
account key handle (L2, Rust-owned)
  -> create_identity_handle(account_key_handle)
     -> random identity_seed(32)
     -> wrapped_seed = XChaCha20-Poly1305(account_key, identity_seed)
     -> identity handle stores Rust-owned zeroizing signing seed
     -> returns public signing key, public X25519 recipient key, wrapped_seed

wrapped_seed + account key handle
  -> open_identity_handle(wrapped_seed, account_key_handle)
     -> unwrap identity_seed with L2
     -> derive identity key material
     -> return opaque handle + public bytes only

manifest transcript bytes + identity handle
  -> sign_manifest_with_identity(handle, transcript)
     -> 64-byte Ed25519 detached signature
```

## Zero-Knowledge and FFI Invariants

- Raw account keys and identity seeds never leave Rust through FFI.
- FFI outputs are limited to opaque handles, public keys, signatures, and encrypted wrapped seed bytes.
- Identity signing seeds are Rust-owned zeroizing values and do not implement `Debug`, `Clone`, `Copy`, `Display`, or serialization.
- Closing an account-key handle closes any identity handles derived from it.
- Identity handles can be explicitly closed and wiped.
- Server-visible outputs remain public cryptographic metadata only: identity public key, recipient X25519 public key, and detached signatures.

## Public Key Policy

The backend currently stores `IdentityPubkey` as the user's Ed25519 identity public key. Rust also derives the X25519 public key from the same Ed25519 identity public key for recipient sealed-box addressing, matching the existing TypeScript/libsodium model. This slice exposes the X25519 public key but does not yet implement sealed-box open/seal operations.

## Verification Plan

- Crypto tests prove fixed identity seed vectors for Ed25519 public key and Ed25519-to-X25519 public key conversion.
- Crypto tests prove identity seed input zeroization and invalid-length rejection.
- Client tests prove create/open/close handle lifecycle, wrapped seed round trip, manifest signing, tamper rejection, and account-close cascade.
- UniFFI and WASM snapshot tests prove identity facade functions remain stable and return stable error codes.
- Full Rust quality gate remains green across native, WASM, Android, cargo-deny, and cargo-vet.

