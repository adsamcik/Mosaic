# SPEC: Android Media Core Bridge Readiness

## Status

Implemented for Android manual one-photo encrypted upload readiness.

## Scope

This slice exposes the dependency-free parts of `mosaic-media` through the
Android UniFFI facade without adding Rust image codec dependencies or building
the Android upload UI. Android remains responsible for Photo Picker access and
platform-native thumbnail/preview encoding for the MVP.

Included:

- media byte inspection for JPEG, PNG, and WebP container metadata;
- canonical thumbnail, preview, and original tier layout planning;
- canonical media metadata sidecar construction from inspected media bytes;
- metadata sidecar encryption through an existing epoch-key handle;
- Rust architecture boundary updates allowing `mosaic-uniffi` to depend on
  `mosaic-media` while keeping `mosaic-client` and `mosaic-crypto` independent
  from media processing.

Excluded:

- concrete Rust JPEG, PNG, WebP, HEIC/HEIF, or AVIF codecs;
- Android UI, Photo Picker, staging queue, or upload orchestration;
- manifest construction changes;
- backend/API changes.

## Data Flow

```text
Android Photo Picker bytes
  -> mosaic_uniffi::inspect_media_image(bytes)
     -> MediaMetadataResult { format, mime_type, width, height, orientation }
  -> mosaic_uniffi::plan_media_tier_layout(width, height)
     -> thumbnail/preview/original target dimensions
  -> Android native media adapter encodes metadata-stripped tiers
  -> mosaic_uniffi::encrypt_shard_with_epoch_handle(...)
     -> encrypted tier envelopes + SHA-256
  -> mosaic_uniffi::encrypt_media_metadata_sidecar_with_epoch_handle(...)
     -> encrypted metadata sidecar envelope + SHA-256
```

`canonical_media_metadata_sidecar_bytes` is exposed for vector/debug parity and
returns plaintext client-local metadata sidecar bytes. Production upload code
must use the encrypted helper or immediately encrypt and wipe the plaintext
result before persistence, manifest binding, upload, or logging.

## Zero-Knowledge Invariants

- All inspection, tier planning, sidecar construction, and sidecar encryption
  run client-side.
- The backend continues to receive only opaque encrypted shard/sidecar bytes.
- Plaintext media bytes passed to media inspection/sidecar helpers are wrapped
  in `Zeroizing<Vec<u8>>` inside the UniFFI boundary.
- Plaintext sidecar bytes are zeroized after the encrypted sidecar helper calls
  the epoch-handle shard encryption path.
- The Android bridge does not expose raw account, identity, epoch, or tier keys.

## Component Tree

```text
crates/mosaic-media
  src/lib.rs
    inspect_image
    plan_tier_layout
    canonical_media_metadata_sidecar_bytes

crates/mosaic-uniffi
  src/lib.rs
    MediaMetadataResult
    MediaTierDimensions
    MediaTierLayoutResult
    inspect_media_image
    plan_media_tier_layout
    canonical_media_metadata_sidecar_bytes
    encrypt_media_metadata_sidecar_with_epoch_handle
```

## Verification Plan

- `cargo test -p mosaic-media -p mosaic-domain`
- `cargo test -p mosaic-uniffi --test ffi_snapshot`
- `cargo fmt --all --check`
- `cargo clippy -p mosaic-uniffi --all-targets --all-features -- -D warnings`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File .\tests\architecture\rust-boundaries.ps1`
- `.\scripts\build-rust-android.ps1` when the local Android Rust toolchain is available
- `git --no-pager diff --check`

## Remaining Non-Blocking Prototype Work

The full ADR-008 Rust codec adoption prototype remains open until JPEG, PNG,
WebP, HEIC/HEIF, and AVIF codec candidates are measured on web and Android.
That blocker is not required for the Android manual one-photo encrypted upload
MVP because the MVP may use platform-native codec adapters that satisfy the
metadata stripping, sidecar encryption, and zero-knowledge requirements.
