# Manifest Canonical Transcript

## Scope

This slice adds a dependency-free Rust domain transcript builder for future manifest signatures. It does not add Ed25519 signing, backend verification, web cutover, Android code, or FFI exports.

## Data flow

Inputs are the values the client already knows when finalizing an encrypted upload:

```text
album_id: [u8; 16]              # UUID bytes, client/domain canonical representation
epoch_id: u32                   # epoch used by the encrypted metadata envelope
encrypted_meta: &[u8]           # encrypted manifest metadata envelope bytes
shards: &[ManifestShardRef]     # server shard id + tier + encrypted shard hash
```

`ManifestShardRef`:

```text
chunk_index: u32
shard_id: [u8; 16]
tier: ShardTier                 # 1=thumbnail, 2=preview, 3=original
sha256: [u8; 32]                # encrypted shard SHA-256 bytes
```

Output:

```text
canonical_transcript: Vec<u8>
```

The future signing slice signs the canonical transcript bytes directly. The current TypeScript path signs only `Mosaic_Manifest_v1 || encryptedMeta`; Rust v1 intentionally strengthens this by binding album, epoch, encrypted metadata, shard order, shard IDs, shard tiers, and shard ciphertext hashes.

## ZK invariants

- The transcript contains only encrypted metadata bytes and server-visible upload/linkage metadata.
- Plaintext filename, dimensions, captions, preserved EXIF, GPS, thumbnails, and decrypted metadata remain inside `encrypted_meta`.
- The backend still stores opaque encrypted metadata and shard references; it does not parse or verify plaintext.
- No signing key or decrypted manifest field crosses FFI in this slice.

## Canonical binary format

All integers are little-endian. The format is intentionally binary, not JSON, to avoid object field ordering, sparse optional fields, float formatting, Unicode normalization, and base64 variation.

```text
magic/context       "Mosaic_Manifest_v1" bytes
format_version      u8 = 1
album_id            16 bytes
epoch_id            u32
encrypted_meta_len  u32
encrypted_meta      encrypted_meta_len bytes
shard_count         u32

repeat shard_count:
  chunk_index        u32
  tier               u8
  shard_id           16 bytes
  sha256             32 bytes
```

Validation:

- `encrypted_meta` must be non-empty.
- `encrypted_meta.len()` and `shards.len()` must fit in `u32`.
- `shards` must be non-empty.
- Shards are canonicalized by sorting by `chunk_index`.
- Sorted shard indices must be exactly sequential `0..n`.
- Duplicate/missing indices are rejected before transcript creation.

## Component tree

```text
crates/mosaic-domain
  src/lib.rs
    MANIFEST_SIGN_CONTEXT
    MANIFEST_TRANSCRIPT_VERSION
    ManifestShardRef
    ManifestTranscript
    ManifestTranscriptError
    canonical_manifest_transcript_bytes
  tests/manifest_transcript.rs
    vectors, order canonicalization, validation failures
```

No `mosaic-crypto`, backend, web, Android, WASM, or UniFFI changes are part of this slice.

## Verification plan

1. `cargo test -p mosaic-domain --test manifest_transcript --locked` fails before implementation and passes after.
2. `cargo test -p mosaic-domain --locked` passes.
3. `cargo clippy --workspace --all-targets --all-features -- -D warnings` passes.
4. `cargo deny check` passes.
5. `cargo vet` passes.
6. `.\scripts\rust-check.ps1` passes.
7. `.\scripts\build-rust-wasm.ps1` passes.
8. `.\scripts\build-rust-android.ps1` passes.
9. `git --no-pager diff --check` passes.

