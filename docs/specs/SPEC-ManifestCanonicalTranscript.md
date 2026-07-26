# Manifest Canonical Transcript

## Status

Locked at v1. Implemented in `933382f` (`feat(domain): add manifest signing
transcript`) — `Mosaic_Manifest_v1` canonical transcript builder over album,
epoch, encrypted metadata, and per-shard refs (id, tier, ciphertext SHA-256).
Signed/verified by `mosaic-crypto` per `SPEC-RustManifestSigning.md` and
covered by the cross-platform `manifest_transcript.json` corpus in
`tests/vectors/`.

### Current v2 amendment

The format below is retained only for legacy verification. Every current public
manifest producer calls
`canonical_manifest_transcript_bytes_v2(transcript, manifest_seq)`, using the
byte-distinct `Mosaic_Manifest_v2` context and version `0x02`. The v2 layout
inserts the signed little-endian `i64 manifest_seq` immediately after
`epoch_id`; public producer routes require that sequence to be positive and
backed by the matching target-bound reservation.

Create, metadata-update, and tombstone flows reserve before signing. Receive
adapters verify v2 and keep the accepted checkpoint per logical manifest in
separate encrypted security state. V1 input may be verified for legacy reads,
but must not be emitted by a current write path.

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

At the time of this original slice, the TypeScript path signed only `Mosaic_Manifest_v1 || encryptedMeta`; the Rust v1 builder strengthened that historical format by binding album, epoch, encrypted metadata, shard order, shard IDs, shard tiers, and shard ciphertext hashes.

## ZK invariants

- The transcript contains only encrypted metadata bytes and server-visible upload/linkage metadata.
- Plaintext filename, dimensions, captions, preserved EXIF, GPS, thumbnails, and decrypted metadata remain inside `encrypted_meta`.
- The backend still stores opaque encrypted metadata and shard references; it does not parse or verify plaintext.
- No signing key or decrypted manifest field crosses FFI in this slice.

## Current v2 canonical binary format

All integers are little-endian. V2 is additive over the v1 layout and changes
both its context/version bytes and the signed sequence field:

```text
magic/context       "Mosaic_Manifest_v2" bytes
format_version      u8 = 2
album_id            16 bytes
epoch_id            u32
manifest_seq        i64
# encrypted metadata and canonical shard sequence continue as in v1 below
```

The public API requires `manifest_seq > 0`; changing it invalidates the Ed25519
signature. The reservation ID is server validation state and is not itself part
of these transcript bytes.

## Historical v1 canonical binary format

The legacy format is intentionally binary, not JSON, to avoid object field ordering, sparse optional fields, float formatting, Unicode normalization, and base64 variation.

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
    MANIFEST_SIGN_CONTEXT_V2
    MANIFEST_TRANSCRIPT_VERSION_V2
    ManifestShardRef
    ManifestTranscript
    ManifestTranscriptError
    canonical_manifest_transcript_bytes
    canonical_manifest_transcript_bytes_v2
  tests/manifest_transcript.rs + tests/manifest_transcript_v2.rs
    vectors, signed-sequence binding, order canonicalization, validation failures
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

