# Rust Encrypted Metadata Sidecar

## Status

Locked at v1. Implemented in `58ca56f` (`feat(domain): add encrypted metadata
sidecar`) and `8d43e9a` (`fix(domain): wrap metadata envelope test`). The
schema is bound into the media pipeline via `5bfdf5b` (`feat(media): integrate
metadata sidecars`) and exposed across UniFFI/WASM by `65ba9d6` (`feat(uniffi):
expose metadata sidecar encryption`).

## Scope

This slice adds a dependency-free Rust domain schema for deterministic canonical
metadata sidecar bytes. The sidecar is part of Mosaic's required media golden
flow, not an optional extension.

Included:

- client-local canonical metadata sidecar input type
- generic TLV field records with known field tag constants
- deterministic binary serialization
- validation for canonical field ordering, duplicate tags, zero tags, empty
  field values, and length bounds
- tests for golden bytes and manifest transcript ciphertext binding

Excluded:

- encryption/decryption
- Ed25519 signing
- backend parsing or validation
- web, Android, WASM, UniFFI, or media pipeline cutover
- typed constructors for every known metadata field

## Data flow

Canonical sidecar construction is client-local plaintext only:

```text
MetadataSidecar
  album_id: [u8; 16]
  photo_id: [u8; 16]
  epoch_id: u32
  fields: &[MetadataSidecarField]

MetadataSidecarField
  tag: u16
  value: &[u8]

canonical_metadata_sidecar_bytes(sidecar) -> Vec<u8>
```

The returned canonical sidecar bytes are then encrypted by a later crypto/media
slice with the epoch/content key:

```text
canonical_metadata_sidecar_bytes
  -> encrypted/opaque sidecar envelope bytes
  -> EncryptedMetadataEnvelope::new(encrypted_sidecar_envelope_bytes)
  -> ManifestTranscript::new(album_id, epoch_id, encrypted_meta, shards)
  -> canonical_manifest_transcript_bytes
```

`ManifestTranscript::new(... encrypted_meta ...)` receives an
`EncryptedMetadataEnvelope`, not a bare byte slice. Production paths must only
construct that wrapper after encrypting canonical sidecar bytes.

## ZK invariants

- The Rust domain sidecar schema has no crypto in this slice.
- Canonical sidecar bytes may contain plaintext filenames, dimensions, captions,
  preserved EXIF/IPTC/XMP/GPS-derived values, and related photo metadata.
- Canonical sidecar bytes remain client-local and are encrypted before upload,
  manifest signing, or backend storage.
- The backend/server only sees encrypted/opaque sidecar envelope bytes and
  server-visible shard references.
- Manifest signing binds encrypted/opaque sidecar envelope bytes, not plaintext
  canonical sidecar bytes.
- Manifest transcript construction uses an `EncryptedMetadataEnvelope` wrapper
  so plaintext canonical sidecar bytes do not type-check as transcript metadata.
- No logging, filesystem I/O, network I/O, serde, unsafe code, or new dependency
  is added.

## Canonical binary format

All integers are little-endian. The format is binary rather than JSON to avoid
object ordering, float formatting, sparse optional fields, Unicode
normalization, and base64 variation.

```text
context       "Mosaic_Metadata_v1" bytes
version       u8 = 1
album_id      16 bytes
photo_id      16 bytes
epoch_id      u32
field_count   u32

repeat field_count:
  tag          u16
  length       u32
  value        length bytes
```

The context and version are distinct from `Mosaic_Manifest_v1` so sidecar bytes
cannot be confused with manifest signing transcripts.

## Field tags

Known field tags are stable protocol constants. Values are generic TLV payloads
so higher layers can evolve typed encoders without changing the canonical
container:

| Tag | Name | Value encoding |
|-----|------|----------------|
| 1 | orientation | little-endian `u16` |
| 2 | device timestamp ms | little-endian Unix epoch milliseconds `i64` |
| 3 | original dimensions | little-endian width `u32`, height `u32` |
| 4 | MIME override | UTF-8 bytes |
| 5 | caption | UTF-8 bytes |
| 6 | filename | UTF-8 bytes |
| 7 | camera make | UTF-8 bytes |
| 8 | camera model | UTF-8 bytes |
| 9 | GPS | client metadata layer payload |

## Validation

- `field_count` must fit in `u32`.
- Each field `length` must fit in `u32`.
- Empty field lists are valid and encode as `field_count = 0`.
- Individual field values must be non-empty; omit absent metadata instead.
- Field tags must be non-zero.
- Fields must be supplied in strictly ascending tag order.
- Duplicate tags are rejected.
- Unsorted input is rejected rather than silently sorted, preserving explicit
  canonical transcript strictness.

## Component tree

```text
crates/mosaic-domain
  src/lib.rs
    METADATA_SIDECAR_CONTEXT
    METADATA_SIDECAR_VERSION
    metadata_field_tags
    MetadataSidecarField
    MetadataSidecar
    EncryptedMetadataEnvelope
    MetadataSidecarError
    canonical_metadata_sidecar_bytes
    ManifestTranscript encrypted_meta documentation

  tests/metadata_sidecar.rs
    golden sidecar bytes
    empty sidecar bytes
    unsorted and duplicate tag rejection
    zero tag and empty field value rejection
    manifest transcript encrypted/opaque sidecar binding invariant
```

No backend, web, Android, WASM, UniFFI, or crypto crate changes are part of this
slice.

## Verification plan

TDD:

1. Add `crates/mosaic-domain/tests/metadata_sidecar.rs`.
2. Run `cargo test -p mosaic-domain --test metadata_sidecar --locked` and
   confirm RED failure from missing API.
3. Implement the dependency-free schema in `crates/mosaic-domain/src/lib.rs`.
4. Re-run the focused sidecar test and confirm GREEN.

Final gate:

1. `cargo fmt --all --check`
2. `cargo test -p mosaic-domain --locked`
3. `cargo clippy --workspace --all-targets --all-features -- -D warnings`
4. `cargo deny check`
5. `cargo vet`
6. `.\scripts\rust-check.ps1`
7. `.\scripts\build-rust-wasm.ps1`
8. `.\scripts\build-rust-android.ps1`
9. `git --no-pager diff --check`
