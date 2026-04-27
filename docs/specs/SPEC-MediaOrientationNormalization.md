# Media Orientation Normalization

## Problem

Android Photo Picker can return JPEG bytes whose pixels are stored in one orientation while EXIF tag `0x0112` describes the intended display transform. Mosaic gallery tiers must be visually consistent across web and Android, but server-bound tier bytes must not carry plaintext EXIF metadata.

## Approach

`mosaic-media` will parse JPEG EXIF orientation as part of dependency-free image inspection. `inspect_image` returns:

- canonical container format and MIME type;
- display-normalized dimensions for tier planning;
- the canonical EXIF orientation value (`1..=8`) that callers can store only inside encrypted metadata.

No pixel decoding, transcoding, filesystem access, network access, or codec dependency is introduced in this slice.

## Data Flow

```text
Device JPEG bytes
  -> mosaic-media::inspect_image
     -> read container dimensions from SOF
     -> read EXIF APP1 TIFF IFD0 orientation tag 0x0112 when present
     -> normalize dimensions for orientations 5..=8
  -> tier planner uses normalized dimensions
  -> strip_known_metadata removes EXIF from gallery tier bytes before encryption
  -> encrypted metadata sidecar may preserve orientation value
```

## Zero-Knowledge Invariants

- Orientation is parsed on the client side only.
- EXIF bytes are stripped from gallery tier media before server upload.
- Any preserved orientation value belongs in encrypted metadata, never in plaintext API fields.
- The backend continues to receive only opaque encrypted blobs.

## Policy

- JPEG EXIF orientation tag `0x0112` is supported for this slice.
- Missing, malformed, or out-of-range orientation metadata is treated as orientation `1` because EXIF metadata is optional and stripped after inspection.
- Malformed image containers still return the existing format-specific errors.
- Orientations `5`, `6`, `7`, and `8` swap display width and height for tier planning.
- PNG/WebP orientation parsing is deferred; they return orientation `1` in this slice while their EXIF metadata carriers remain stripped by `strip_known_metadata`.

## Verification Plan

- Unit tests prove JPEG EXIF orientation parsing for both little-endian and big-endian TIFF payloads.
- Unit tests prove `inspect_image` returns display-normalized dimensions for rotated JPEGs.
- Unit tests prove missing or invalid orientation metadata defaults to normal orientation.
- Unit tests prove metadata stripping removes EXIF orientation from gallery-tier bytes.
- Existing media metadata stripping and dimension inspection tests continue to pass.

