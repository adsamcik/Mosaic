# Rust Encrypted Metadata Sidecar

## Status

Locked at v1. Implemented in `58ca56f` (`feat(domain): add encrypted metadata
sidecar`) and `8d43e9a` (`fix(domain): wrap metadata envelope test`). The
schema is bound into the media pipeline via `5bfdf5b` (`feat(media): integrate
metadata sidecars`) and exposed across UniFFI/WASM by `65ba9d6` (`feat(uniffi):
expose metadata sidecar encryption`).

**Superseded for tag registry:** this SPEC remains authoritative for the
`Mosaic_Metadata_v1` envelope and TLV byte shape only. The authoritative
append-only tag registry, tag status vocabulary, privacy classes, reserved
ranges, and tag-specific layout commitments are now
[`SPEC-CanonicalSidecarTags.md`](SPEC-CanonicalSidecarTags.md). If the tag table
below conflicts with the canonical registry, the canonical registry wins.

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
- Canonical sidecar bytes may contain plaintext dimensions, MIME hints, captions
  only after a future ADR promotes tag 5, preserved EXIF/IPTC/XMP/GPS-derived
  values only after their reserved tags are promoted, and related photo metadata.
  Filenames are forbidden payloads; tag 6 is reserved only and producers must
  not emit it.
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

Known field tags are stable protocol constants, but current tag status and
tag-specific payload rules are governed by
[`SPEC-CanonicalSidecarTags.md`](SPEC-CanonicalSidecarTags.md). Values are
generic TLV payloads so higher layers can evolve typed encoders without changing
the canonical container:

| Tag | Name | Current status | Value encoding / registry note |
|-----|------|----------------|-------------------------------|
| 1 | orientation | Active | little-endian `u16` |
| 2 | device timestamp ms | ReservedNumberPending | layout pending R-M4; producers must not emit |
| 3 | original dimensions | Active | little-endian width `u32`, height `u32` |
| 4 | MIME override | Active | byte-exact UTF-8 bytes; no NFC normalization or tag-specific byte cap |
| 5 | caption | ReservedNumberPending | reserved for future ADR; producers must not emit |
| 6 | filename | Forbidden | FORBIDDEN — see ADR-017 §"Registry rules" item 5; producers must not emit |
| 7 | camera make | ReservedNumberPending | layout pending R-M4; producers must not emit |
| 8 | camera model | ReservedNumberPending | layout pending R-M4; producers must not emit |
| 9 | GPS | ReservedNumberPending | layout pending R-M3; producers must not emit |

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
- Production encoding rejects `ReservedNumberPending`, `Forbidden`, and unknown
  tags before checking empty field values, so tag-status telemetry is not
  bypassed by an empty payload.
- The complete canonical sidecar byte buffer is capped by
  `MAX_SIDECAR_TOTAL_BYTES = 65_536` (64 KiB) as a defense-in-depth
  allocation bound. R-M5.2.2 tightened the provisional R-M5.2.1
  `1_500_000` byte (1.5 MB) value before v1 freeze after confirming the
  current worst-case legitimate active-tag sidecar is 97 bytes
  (`59 + (3 * 6) + 2 + 8 + 10`).

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
