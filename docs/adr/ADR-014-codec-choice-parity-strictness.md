# ADR-014: Codec choice + parity strictness (collapses D1+D4)

## Status

Accepted. Decision: **Outcome B — platform codecs with deterministic Rust-side strip + sidecar; codec output is visually equivalent, not byte-equal, across platforms.**

This ADR amends and closes the open question in [ADR-008](ADR-008-media-processing-gate.md) ("Gate Rust media processing behind cross-platform prototype results"). It depends on [ADR-020](ADR-020-supply-chain-amendment.md) for the conditional native-codec supply-chain rules that would activate under Outcome A.

## Context

[ADR-008](ADR-008-media-processing-gate.md) gated Rust codec adoption behind a cross-platform prototype. The Android closeout evidence in ADR-008 (2026-04-28) accepted **platform-native codec adapters** for the Android manual upload MVP while keeping Rust media-core for inspection, tier planning, metadata stripping, and sidecar construction.

The Rust core completion programme inherits two coupled questions, originally listed as separate decisions D1 and D4 in `plan.md` v1:

- **D1 (codec choice):** adopt Rust codecs (Outcome A — `image-rs`, `libavif-sys`/`rav1e`/`aom-sys`, `libwebp-sys`) or keep platform codecs (Outcome B — Canvas/heic-to on web, `BitmapFactory`/`ImageDecoder` on Android)?
- **D4 (parity strictness):** require byte-equal encrypted shard bytes for image tiers across web ↔ Android, or accept visual equivalence + byte-equal sidecar/strip/manifest?

The 3-reviewer pass (`files/reviews/R2`, `R3`) confirmed these decisions are inseparable: byte-equal encrypted shards require byte-equal plaintext tier bytes, which require byte-equal encoder output, which requires Rust codecs everywhere. Choosing one half of the pair without the other produces a forever-failing parity gate (Q-final-1) or a forever-redundant supply-chain expansion.

Cross-cutting evidence:

- ADR-008 already accepts visual equivalence; ADR-014 should not retreat from that posture without measurement justifying the cost.
- Adopting native C codec libraries (`libavif-sys`, `rav1e`, `aom-sys`, `libwebp-sys`) adds 5–20 MiB to web WASM bundle and Android arm64 cdylib; ADR-020 sets binary-size budgets that must be measurable.
- Web browsers ship hardware-accelerated codecs in `Canvas.toBlob()`; replacing them with software WASM codecs measurably regresses encode time on user devices.
- Android system codecs are hardware-accelerated; replacing them with Rust software codecs regresses battery + thermal + encode time.
- Cross-client byte parity at the encrypted-shard level is not required by the zero-knowledge model: server stores opaque bytes; clients decrypt locally and render from whatever bytes were uploaded.
- Cross-client *protocol* parity *is* required: envelope, manifest transcript, sidecar bytes, stripped-tier metadata removal, tier dimensions. Q-final-1 covers these explicitly.

## Decision

**Outcome B — platform codecs with Rust-side determinism for everything that matters protocol-wise.**

Specifically:

### Codec ownership
- **Web:** Canvas 2D API + `Canvas.toBlob()` for tier encoding (thumbnail, preview, original-as-AVIF/WebP). HEIC decoded via `heic-to`. WebCodecs `VideoDecoder` / `<video>` element for video frame extraction.
- **Android:** `BitmapFactory` / `ImageDecoder` for decoding; `Bitmap.createScaledBitmap` (or upcoming `ImageDecoder.OnHeaderDecodedListener` downscaling for memory safety) for resize; `Bitmap.compress` for encoding. `MediaMetadataRetriever` for video frame extraction.

### Rust ownership (deterministic, byte-equal across platforms)
- **Inspection:** `inspect_media_image` — JPEG/PNG/WebP/AVIF/HEIC magic + dimension parsing + EXIF orientation extraction.
- **Tier-dimension planning:** `plan_media_tier_layout` + the new `MediaTierLayout::CANONICAL` constant that both web and Android read from a single source (per A-CanonicalDimensions).
- **Metadata stripping:** `strip_known_metadata` exposed via WASM (P-W2) and UniFFI (P-U1). Platforms call Rust to strip *after* platform encoding produces the tier bytes.
- **Sidecar construction + encryption:** `canonical_media_metadata_sidecar_bytes` + `encrypt_media_metadata_sidecar_with_epoch_handle`.
- **Manifest transcript:** `canonical_manifest_transcript_bytes`.
- **Shard AEAD:** `encrypt_shard_with_epoch_handle` / `decrypt_shard_with_epoch_handle`.

### Parity matrix (Q-final-1)
- **Byte-equal across web ↔ Android ↔ native Rust** (locked by Q-final-1 nightly):
  - envelope bytes (header + nonce + ciphertext + tag) for identical input + identical key,
  - manifest transcript bytes for identical fixtures,
  - sidecar bytes for every supported image and video format,
  - metadata-stripped bytes for every codec-frozen format (JPEG / PNG / WebP) — i.e. bytes after Rust strip but before platform re-encode,
  - `MediaTierLayout::CANONICAL` dimensions,
  - thumbhash bytes — see thumbhash exception below.
- **Visual equivalence only** (codec output divergence allowed and documented):
  - tier-encoded thumbnail / preview / AVIF-original bytes,
  - encrypted shard bytes that wrap codec output (because plaintext differs),
  - video poster-frame JPEG bytes.
- **Thumbhash exception:** thumbhash byte-equality is required only when both sides feed *the same* JPEG bytes through the thumbhash algorithm. Because platforms produce different JPEG bytes from the same source frame, Q-final-1 compares thumbhash *similarity* for source-frame inputs as **Hamming distance ≤ 6 bits over the canonical 25-byte thumbhash fingerprint** (the thumbhash format is a fixed-bit-length encoding; a 6-bit drift over ~200 bits is ~3% disagreement and corresponds to perceptually equivalent low-frequency thumbnails). Direct-JPEG-input inputs (same JPEG bytes both sides) are byte-equal.

### Forbidden surfaces
- No native C codec library (`libavif-sys`, `rav1e`, `aom-sys`, `libwebp-sys`) is added to the supply chain. ADR-020's conditional native-codec subsection remains dormant.
- `image-rs` may appear only as a `[dev-dependencies]` reference impl for differential testing of strip / sidecar / inspection — never at runtime.
- No new attempt to re-implement HEIC decode in Rust during this programme.

### Encoding contracts platforms must satisfy
- Tier-encoded bytes pass through `strip_known_metadata` *after* platform encode and *before* Rust shard encryption. This guarantees no platform-injected EXIF / XMP / IPTC leaks into the encrypted shard, even if the platform encoder leaks metadata.
- Tier dimensions exactly match `MediaTierLayout::CANONICAL`. Adapter outputs validated by Rust before shard encryption (`encode_and_validate_tier` returns `EncodedTierMismatch` on drift).
- Encoder quality settings documented per platform; codec choice documented; per-platform fixtures captured for visual-regression tests.

## Options Considered

### Outcome A — Rust codecs everywhere
- Pros: byte-equal encrypted shards across platforms; one codec implementation to audit.
- Cons: 5–20 MiB binary bloat on web *and* Android; loss of hardware acceleration on both sides; native C codec attack surface (`libavif-sys`/`rav1e`/`aom-sys`/`libwebp-sys` are CVE-prone); Q-final-4 performance budget regression risk; adds significant supply-chain weight under ADR-020; HEIC remains hard to support purely in Rust.
- Conviction: 4/10.

### Outcome B — platform codecs with Rust-side determinism (this decision)
- Pros: hardware acceleration preserved; smallest supply chain; smallest binary; existing Slice 8 / Android closeout evidence honored; Q-final-1 still strict on every byte that matters protocol-wise; platforms remain free to choose codec quality settings appropriate to their HW.
- Cons: encrypted shard bytes are not byte-equal across platforms (Q-final-1 makes this explicit); two codec implementations to test (one per platform); platform encoders may leak metadata that Rust must strip post-encode.
- Conviction: 9/10.

### Hybrid — Rust codecs on web only, platform codecs on Android
- Pros: web sees byte-equal output of WASM-encoded tiers across browsers (already achievable with Canvas portability anyway).
- Cons: still no cross-platform byte-equality (Android still differs); doubles supply chain on web; costs hardware acceleration on web; gains nothing protocol-wise.
- Conviction: 2/10.

## Consequences

- ADR-008 is now closed. The "broader Rust codec prototype" referenced there is **not pursued** for v1.
- ADR-020 native-codec subsection stays dormant.
- A6 (Android tier generator) ships as the **Outcome B implementation**: `BitmapFactory`/`ImageDecoder` → resize → encode → Rust `strip_known_metadata` → tier bytes. Memory-bounded with downsampling for >64MP sources.
- W-I1 / W-I2 / W-I3 retain Canvas/heic-to encoding; W-I3's "JPEG strip parity flip" lands by routing post-Canvas JPEG bytes through Rust `strip_known_metadata` (parity with TS stripper required only at strip *output*, not at codec output).
- Q-final-1 nightly parity matrix asserts the byte-equal items above and the visual-equivalence items via documented similarity metrics. Drift outside the documented divergence classes fails the gate.
- Q-final-4 binary-size budgets do not include native codec libraries; budget targets reflect Outcome B.
- Web encrypted local cache (`db.worker.ts`) and Android Room schemas store encrypted opaque bytes; codec divergence is invisible to storage.
- A new SPEC `docs/specs/SPEC-MediaTierEncodingContracts.md` documents the per-platform encoder contract, quality settings, post-encode strip requirement, and visual-regression fixtures.

## Reversibility

Medium. ADR-014 closes ADR-008's open question and locks Outcome B for v1. A future v1.x ADR may re-open Outcome A for specific tier types (e.g. AVIF originals) without invalidating any protocol-frozen byte (envelope, manifest, sidecar, stripped tier bytes, dimensions) — those are codec-independent. The platform encoder contract documented in `SPEC-MediaTierEncodingContracts.md` may be tightened or branched per-tier in v1.x without contradicting this ADR.
