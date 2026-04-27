# SPEC: Media Tier Generation Adapter

## Status

Approved for implementation.

## Scope

This slice adds a dependency-free, deterministic orchestration contract for generating Mosaic gallery media tiers. It bridges existing inspection, metadata stripping, and canonical layout planning to a future codec adapter boundary without selecting or adding JPEG, WebP, or AVIF codec dependencies.

The slice intentionally does not add real image decoding/encoding, filesystem access, platform-specific Android bindings, backend/API/web code, encryption, manifest writing, or external codec crates.

## Data Flow

Inputs:

```text
original_bytes: &[u8]
encoder: MediaTierEncoder
```

Generation pipeline:

```text
original_bytes
  -> inspect_image(original_bytes)
     -> ImageMetadata { format, mime_type, normalized width/height, orientation }
  -> strip_known_metadata(metadata.format, original_bytes)
     -> sanitized source bytes for gallery tiers
  -> plan_tier_layout(metadata.width, metadata.height)
     -> TierLayout in thumbnail -> preview -> original order
  -> encoder.encode_tier(sanitized_source, metadata, thumbnail dimensions)
  -> encoder.encode_tier(sanitized_source, metadata, preview dimensions)
  -> sanitized_source assigned to original tier output
```

Output:

```text
GeneratedTiers {
  tiers: [
    TierOutput { tier: ShardTier::Thumbnail, width, height, bytes },
    TierOutput { tier: ShardTier::Preview,   width, height, bytes },
    TierOutput { tier: ShardTier::Original,  width, height, sanitized original bytes },
  ]
}
```

The original tier is metadata-stripped before any caller can pass it to encryption. Thumbnail and preview adapter inputs are the same sanitized source bytes, plus the already-inspected normalized metadata needed by a future codec to apply orientation policy.

## Adapter Contract

`MediaTierEncoder` is a pure media-core boundary:

- receives only sanitized media bytes, `ImageMetadata`, and the requested `TierDimensions`;
- returns a `TierOutput` for the requested thumbnail or preview tier;
- must not read filenames, captions, platform EXIF fields, keys, server/API data, or global process state;
- may return a typed `MosaicMediaError`, which the orchestration layer propagates unchanged;
- must return a tier identity and dimensions exactly matching the requested plan.

The orchestration layer validates every adapter output against the planned `ShardTier` and dimensions. Mismatches return a media-core error before any bytes are accepted for encryption.

## Validation

- Unsupported or malformed input fails during `inspect_image` before the encoder is called.
- Public helper paths that accept pre-inspected metadata re-check that metadata against the source bytes before planning or encoding.
- Metadata stripping failures return existing format-specific errors before the encoder is called.
- JPEG APPn application segments are treated as metadata carriers and removed before adapter handoff.
- Layout planning uses existing `plan_tier_layout` validation for zero and over-budget dimensions.
- Encoded thumbnail and preview outputs must match the planned tier and dimensions exactly.
- Original output is always the stripped source bytes and the planned original dimensions.
- Output order is always thumbnail -> preview -> original.

## Zero-Knowledge Invariants

- The server/backend/API/web/Android layers are not touched in this slice.
- No encryption keys, filenames, captions, plaintext user metadata, platform metadata, or manifest data enter the adapter contract.
- Recognized EXIF, XMP, IPTC, comments, color profiles, timestamps, physical dimensions, and rendering hints are stripped from gallery tier bytes before output.
- The backend continues to receive only opaque encrypted blobs in later upload slices.

## Verification Plan

- Unit tests use a dependency-free fake encoder that records requested tier dimensions and deterministic sanitized source bytes.
- A JPEG with EXIF orientation is inspected, planned from normalized dimensions, encoded for thumbnail/preview with normalized dimensions, and returned with a metadata-stripped original tier.
- Output order is thumbnail, preview, original with expected `ShardTier` values and dimensions.
- Original output no longer exposes EXIF orientation metadata.
- Adapter tier/dimension mismatches are rejected with a typed `MosaicMediaError`.
- Adapter errors propagate without being swallowed or replaced.
- Unsupported/malformed input fails before any adapter call.
- Small sources are not upscaled.
- Extreme valid aspect ratios produce non-zero thumbnail/preview dimensions through the full generation path.

## Next Slice

Select and vet real codec adapters for JPEG/WebP/AVIF generation. That slice must justify dependency choices, verify supply-chain status, prove deterministic orientation handling, and add integration tests with real encoded media fixtures before Android upload wiring consumes the adapter.
