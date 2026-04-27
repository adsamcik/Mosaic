# Rust Media Metadata Sidecar Integration

## Scope

This slice connects the dependency-free media pipeline to the domain metadata
sidecar schema. It returns canonical gallery tiers plus client-local plaintext
metadata sidecar bytes that must be encrypted by the client crypto layer before
manifest binding, persistence, upload, or logging.

Included:

- stable media sidecar identifiers for album/photo/epoch binding;
- canonical sidecar construction from inspected media metadata;
- a combined tier-generation API that returns sanitized tiers and plaintext
  sidecar bytes together;
- tests that prove sanitized tier bytes do not retain stripped metadata while
  the sidecar preserves the selected metadata values for later encryption.

Excluded:

- encrypting the metadata sidecar;
- binding sidecar ciphertext into manifests;
- real codec adapters;
- platform metadata extraction beyond values already exposed by `ImageMetadata`;
- filenames, captions, EXIF/GPS payload preservation, or source-original archive
  policy.

## Data Flow

```text
source image bytes
  -> inspect_image
     -> ImageMetadata { format, mime_type, normalized dimensions, orientation }
  -> strip_known_metadata + MediaTierEncoder
     -> GeneratedTiers { thumbnail, preview, original }
  -> canonical_media_metadata_sidecar_bytes(MediaSidecarIds, ImageMetadata)
     -> plaintext canonical metadata sidecar bytes
```

The sidecar currently records:

- EXIF orientation as little-endian `u16`;
- normalized source dimensions as little-endian width `u32` then height `u32`;
- trusted container MIME type as UTF-8 bytes.

## Zero-Knowledge Invariants

- Generated gallery tiers remain stripped of recognized metadata carriers.
- Returned sidecar bytes are plaintext and client-local only.
- Manifest construction still requires `EncryptedMetadataEnvelope`, so these
  plaintext sidecar bytes cannot be passed directly to manifest transcript
  construction.
- The API does not introduce logging, filesystem, network, unsafe code, or new
  dependencies.
- The combined result type intentionally does not implement `Debug`.

## Component Tree

```text
crates/mosaic-media
  src/lib.rs
    MediaSidecarIds
    GeneratedMediaWithSidecar
    canonical_media_metadata_sidecar_bytes
    generate_tiers_with_sidecar
```

## Verification Plan

1. Add media tests for deterministic canonical sidecar bytes.
2. Add media tests proving combined generation returns sanitized tiers plus the
   expected sidecar bytes.
3. Run `cargo test -p mosaic-media --locked`.
4. Run `cargo fmt --all --check`.
5. Run `cargo clippy --workspace --all-targets --all-features -- -D warnings`.
6. Run `git --no-pager diff --check`.
