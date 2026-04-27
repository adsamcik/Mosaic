# Rust Manifest Signing

## Scope

This slice adds Rust Ed25519 signing and verification for the canonical manifest transcript produced by `mosaic-domain`.

Included:

- pinned Rust Ed25519 dependency for `mosaic-crypto`
- Rust-owned manifest signing secret/public key types
- random signing key generation using OS CSPRNG
- deterministic seed constructor for restoring/importing wrapped signing keys and for vectors
- manifest transcript signing and verification over exact transcript bytes
- unit tests, golden vector, dependency policy updates, and supply-chain review

Excluded:

- backend signature verification
- web/WASM or Android/UniFFI exports
- TypeScript cutover
- shard signing
- identity signing
- post-quantum or hybrid signatures
- changing the already-approved manifest transcript format

## Data flow

The domain crate already builds canonical transcript bytes:

```text
ManifestTranscript
  album_id: [u8; 16]
  epoch_id: u32
  encrypted_meta: &[u8]
  shards: &[ManifestShardRef]

canonical_manifest_transcript_bytes(transcript) -> Vec<u8>
```

This slice signs those exact bytes:

```text
generate_manifest_signing_keypair()
  -> ManifestSigningKeypair {
       secret_key: ManifestSigningSecretKey,     # Rust-owned secret
       public_key: ManifestSigningPublicKey      # 32 public bytes
     }

sign_manifest_transcript(transcript_bytes, secret_key)
  -> ManifestSignature                           # 64 public bytes

verify_manifest_transcript(transcript_bytes, signature, public_key)
  -> bool
```

`ManifestSigningPublicKey::from_bytes` rejects invalid-length keys and weak/small-order Ed25519 points before constructing the public-key wrapper. Verification uses strict Ed25519 checks so malleable signatures, weak keys, tampered signatures, and tampered transcripts fail closed.

For deterministic vectors and later encrypted-key restore:

```text
ManifestSigningSecretKey::from_seed(seed: &mut [u8])
  validates seed length == 32
  copies the seed into Rust-owned zeroizing storage
  zeroizes the caller-provided seed on success and invalid length
  derives the Ed25519 public key from the seed
```

Production random generation uses `getrandom` inside `mosaic-crypto`; platform adapters do not supply signing randomness.

## Signing transcript rule

`sign_manifest_transcript` signs the exact bytes returned by `canonical_manifest_transcript_bytes`.

It MUST NOT prepend another context string before signing. The canonical transcript already starts with `MANIFEST_SIGN_CONTEXT` and `MANIFEST_TRANSCRIPT_VERSION`, so adding a second prefix would create a new transcript family and complicate interop. Future protocol work can introduce a new transcript version or a `mosaic.v1.manifest.sign` MCEv1 family, but this slice preserves the approved transcript format.

The signature algorithm is plain Ed25519/RFC 8032 over the transcript bytes. No prehash, no randomized signing, and no caller-configurable context label are used.

## ZK invariants

- Signing input contains only the canonical manifest transcript: server-visible IDs/linkage fields plus encrypted metadata bytes.
- Plaintext filenames, captions, dimensions, preserved EXIF/IPTC/XMP/GPS, local asset identities, thumbnails, and other photo metadata remain inside encrypted metadata.
- `ManifestSigningSecretKey` never crosses FFI or the backend in this slice.
- `ManifestSigningPublicKey` and `ManifestSignature` are public server-visible bytes and may cross FFI in later wrapper slices.
- Tests must not print secret seeds or signing secret bytes. Golden vectors may print public keys, signatures, and transcript bytes.
- No logging, I/O, network access, or persistent storage is added.

## Dependency decision

Use `ed25519-dalek` pinned to a single exact version, following ADR-005's accepted pure-Rust crypto dependency decision.

Initial target:

```toml
ed25519-dalek = { version = "=2.1.0", default-features = false, features = ["alloc", "fast", "zeroize"] }
```

Implementation should use the existing `getrandom` dependency to generate a 32-byte Ed25519 seed and construct the signing key from that seed. This avoids adding a caller-visible RNG abstraction or enabling unnecessary `rand_core` key-generation features unless compilation proves the feature set insufficient.

After the dependency is added, the exact Cargo.lock delta determines the audit set. Every newly introduced or materially changed crate in the resolved dependency graph must receive the user's required four independent malicious-code review passes before merge.

Known rejected option:

- `ring` is out of scope because it adds native/C build surface and fails the current pure-Rust WASM/Android portability preference.

## Component tree

```text
crates/mosaic-crypto
  Cargo.toml
    add pinned Ed25519 dependency
  src/lib.rs
    ManifestSigningSecretKey
    ManifestSigningPublicKey
    ManifestSignature
    ManifestSigningKeypair
    generate_manifest_signing_keypair
    sign_manifest_transcript
    verify_manifest_transcript
    signing-related MosaicCryptoError variants if needed
  tests/manifest_signing.rs
    vectors, round trips, tamper detection, key/source zeroization

supply-chain/config.toml
  add cargo-vet exemptions for any unresolved new crates after four-reviewer dependency audit

docs/specs/SPEC-RustManifestSigning.md
  this spec
```

No backend, web, Android, WASM, UniFFI, or `mosaic-domain` implementation changes are part of this slice.

## Verification plan

TDD:

1. Add `crates/mosaic-crypto/tests/manifest_signing.rs`.
2. Run `cargo test -p mosaic-crypto --test manifest_signing --locked` and confirm RED failure from missing API.
3. Add the pinned dependency and implementation.
4. Re-run the focused test and confirm GREEN.

Required tests:

- generated keypair signs and verifies the canonical manifest transcript
- fixed seed produces a stable public key and signature golden vector
- signing the same transcript with the same key is deterministic
- verification fails for a tampered transcript
- verification fails for a tampered signature
- verification fails with the wrong public key
- `from_seed` rejects invalid seed lengths and zeroizes the caller buffer
- public-key construction rejects invalid lengths and weak Ed25519 points
- signature construction rejects invalid lengths
- generated signing secret type does not expose `Debug`, `Clone`, `Copy`, `Serialize`, or raw secret-byte public accessors

Dependency and security review:

1. Add the dependency in the worktree and inspect the exact `Cargo.lock` delta.
2. Launch four independent malicious-code review agents for each newly introduced or materially changed dependency.
3. Run a focused signing API code review.
4. Run a focused security review for transcript binding, key handling, and verification semantics.

Final gate:

1. `cargo fmt --all --check`
2. `cargo test -p mosaic-crypto --test manifest_signing --locked`
3. `cargo test -p mosaic-crypto --locked`
4. `cargo clippy --workspace --all-targets --all-features -- -D warnings`
5. `cargo deny check`
6. `cargo vet`
7. `.\scripts\rust-check.ps1`
8. `.\scripts\build-rust-wasm.ps1`
9. `.\scripts\build-rust-android.ps1`
10. `git --no-pager diff --check`

