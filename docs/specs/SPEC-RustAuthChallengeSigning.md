# Rust Auth Challenge Signing

## Scope

This slice adds Rust-owned LocalAuth challenge signing and verification for account unlock.

Included:

- deterministic password-rooted auth signing key derivation
- Rust-owned auth signing secret/public key types
- canonical auth challenge transcript construction
- Ed25519 signing and strict verification over the auth transcript
- golden-vector and negative tests

Excluded:

- backend verifier changes
- web/WASM or Android/UniFFI exports
- login/session state machines
- account-key unwrap orchestration
- identity keypair derivation from the L2 account key
- registration UI or API changes

## Existing protocol boundary

The current web and backend LocalAuth protocol signs this message:

```text
Mosaic_Auth_Challenge_v1
|| username_len: u32 big-endian
|| username_utf8
|| timestamp_ms?: u64 big-endian
|| challenge: 32 bytes
```

The backend stores only the auth public key and verifies the detached Ed25519 signature. It does not derive auth keys.

Rust keeps this signed transcript shape so the server-side challenge verifier remains compatible. Key derivation becomes Rust-canonical and intentionally does not preserve the old TypeScript BLAKE2b construction because Mosaic is unreleased and Rust is becoming the canonical crypto implementation.

## Data flow

```text
derive_auth_signing_keypair(password, user_salt, kdf_profile)
  L0 = Argon2id(password, user_salt, kdf_profile)
  seed = HKDF-SHA256(L0, salt = user_salt, info = "mosaic:auth-signing:v1")
  auth_secret = Ed25519 signing seed
  auth_public = Ed25519 public key

build_auth_challenge_transcript(username, timestamp_ms, challenge)
  -> canonical bytes

sign_auth_challenge(transcript_bytes, auth_secret)
  -> 64-byte detached Ed25519 signature

verify_auth_challenge(transcript_bytes, signature, auth_public)
  -> bool
```

`password` enters as `Zeroizing<Vec<u8>>`. `user_salt` must be exactly 16 bytes. `challenge` must be exactly 32 bytes. `username` must match the backend LocalAuth username contract: 1-256 ASCII bytes, with only `A-Z`, `a-z`, `0-9`, `_`, `-`, `@`, and `.` allowed. Rust rejects leading/trailing whitespace rather than trimming silently so signed transcripts are byte-identical to backend challenge usernames. `timestamp_ms` is optional and encoded as unsigned 64-bit big-endian when present.

## Transcript rule

`build_auth_challenge_transcript` owns canonical byte construction. Callers must sign exactly those bytes; signing functions do not accept username/challenge fields separately.

The transcript is domain-separated by `AUTH_CHALLENGE_CONTEXT = b"Mosaic_Auth_Challenge_v1"`, matching the current backend verifier. The username length is encoded as a four-byte big-endian integer to avoid concatenation ambiguity. The optional timestamp is encoded as eight-byte big-endian `u64`, matching the backend verifier's unsigned cast of its nullable `long` value for non-negative timestamps.

## ZK and secret-handling invariants

- The server receives only the auth public key and detached signature.
- Password bytes, L0 key material, auth signing seed, and auth signing secret never cross FFI or the backend in this slice.
- `AuthSigningSecretKey` must not implement `Debug`, `Clone`, `Copy`, `Display`, `Serialize`, or public raw-secret accessors.
- Caller-provided seed/password buffers are zeroized on success and validation failure where ownership permits.
- Tests must not print password bytes, L0 bytes, auth seed bytes, or auth signing secrets.
- Auth signing is only for LocalAuth account unlock. It must not be reused for manifest signing, epoch bundle signing, share links, or identity encryption.

## Dependency decision

No new dependencies are allowed in this slice.

Use already-reviewed dependencies:

- `argon2` for L0 derivation
- `hkdf` + `sha2` for auth signing seed expansion
- `ed25519-dalek` for Ed25519 signing and strict verification
- `zeroize` for secret memory hygiene

Because there are no dependency graph changes, the dependency gate is `cargo deny check` and `cargo vet`; no four-reviewer dependency source audit is required.

## Component tree

```text
crates/mosaic-crypto
  src/lib.rs
    AUTH_CHALLENGE_CONTEXT
    AUTH_SIGNING_KEY_INFO
    AUTH_CHALLENGE_BYTES
    AuthSigningSecretKey
    AuthSigningPublicKey
    AuthSignature
    AuthSigningKeypair
    derive_auth_signing_keypair
    build_auth_challenge_transcript
    sign_auth_challenge
    verify_auth_challenge
    validation errors if needed
  tests/auth_challenge_signing.rs
    golden vectors, transcript bytes, round trips, tamper rejection, zeroization

crates/mosaic-client
  src/lib.rs
    client error-code mappings for any new crypto errors

docs/specs/SPEC-RustAuthChallengeSigning.md
  this spec
```

No backend, web, Android, WASM, or UniFFI implementation changes are part of this slice.

## Verification plan

TDD:

1. Add `crates/mosaic-crypto/tests/auth_challenge_signing.rs`.
2. Run `cargo test -p mosaic-crypto --test auth_challenge_signing --locked` and confirm RED failure from missing API.
3. Implement the dependency-free Rust auth signing API.
4. Re-run the focused test and confirm GREEN.

Required tests:

- fixed password/salt/profile derives stable auth public key and signature vector
- transcript bytes match the backend format with timestamp present
- transcript bytes match the backend format without timestamp
- same password/salt/profile derives deterministic keys
- different password or user salt derives a different public key
- generated transcript signs and verifies
- verification fails for tampered challenge transcript
- verification fails for tampered signature
- verification fails with the wrong public key
- invalid salt, challenge length, backend-incompatible username, public-key length, and signature length are rejected
- password/key seed sources are zeroized on success and validation failure where ownership permits
- weak Ed25519 public keys are rejected

Final gate:

1. `cargo fmt --all --check`
2. `cargo test -p mosaic-crypto --test auth_challenge_signing --locked`
3. `cargo test -p mosaic-crypto --locked`
4. `cargo clippy --workspace --all-targets --all-features -- -D warnings`
5. `cargo deny check`
6. `cargo vet`
7. `.\scripts\rust-check.ps1`
8. `.\scripts\build-rust-wasm.ps1`
9. `.\scripts\build-rust-android.ps1`
10. `git --no-pager diff --check`

Focused reviews:

- code review of auth signing API, tests, and client error mappings
- security review for auth transcript binding, key separation, password/seed handling, verification semantics, and LocalAuth replay boundaries
