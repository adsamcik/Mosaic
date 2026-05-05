# SPEC: Metadata Strip Parity

## Status

**Locked** - corresponds to mosaic-media strip surface as of M0 commit.

## Purpose

M0 makes browser upload metadata stripping use the same dependency-free Rust `mosaic-media` container parsers as native clients. The web layer delegates JPEG, PNG, and WebP to `mosaic-wasm`; HEIC and AVIF are handled by the ISO-BMFF strip path, and R-M6 adds video strip support for MP4/MOV/WebM/Matroska before encryption/TUS when the source original would otherwise be preserved.

## Data Flow

1. `apps/web/src/lib/upload/tiered-upload-handler.ts` decides whether the original tier is source-preserved or canvas-reencoded AVIF.
2. Canvas-reencoded AVIF originals are metadata-clean by construction and bypass stripping.
3. Preserved JPEG/PNG/WebP originals call `stripExifFromBlob(blob, mimeType)`.
4. `stripExifFromBlob` reads the `Blob` into a `Uint8Array` and calls `stripJpegMetadata`, `stripPngMetadata`, or `stripWebpMetadata`.
5. `crates/mosaic-wasm` calls `mosaic_media::strip_known_metadata(MediaFormat::{Jpeg,Png,WebP}, bytes)` or the dedicated `strip_video_metadata` path once wrappers expose R-M6.
6. WASM returns `{ code, strippedBytes, removedMetadataCount, free() }`.
7. Web returns `{ bytes, stripped, skippedReason? }`; fail-closed upload handling rejects unsupported or malformed source-preserved originals before encryption or TUS upload.

## Per-format normative strip set

### JPEG

| Marker | Action | Rationale |
|---|---|---|
| APP0 (JFIF) | **STRIP** | M0 follows `mosaic-media`: all APPn carriers are application-defined rendering hints and may fingerprint encoders/devices. |
| APP1 (Exif/XMP/extended XMP) | **STRIP** | Contains GPS, timestamps, camera ID, and XMP metadata. |
| APP2 (ICC profile) | **STRIP** | Color profile may fingerprint device/display pipeline. |
| APP3-APP12 (generic APPn) | **STRIP** | Vendor-specific, unknown contents. |
| APP13 (Adobe IPTC) | **STRIP** | IPTC/Adobe metadata. |
| APP14 (Adobe color transform) | **STRIP** | M0 follows `mosaic-media`: generic APPn rendering hint. |
| COM | **STRIP** | User comment block. |
| SOS + entropy-coded scan tail | Preserve | Pixel data; scan bytes are not segment-structured. |
| DQT/DHT/SOF/DRI/RST/TEM/EOI and other non-APP markers | Preserve | Required image structure or expected harmless markers. |

### PNG

| Chunk | Action | Rationale |
|---|---|---|
| eXIf | **STRIP** | EXIF metadata. |
| iTXt/tEXt/zTXt | **STRIP** | Text annotations including XMP. |
| tIME | **STRIP** | Last-modified timestamp. |
| iCCP, sRGB, cHRM, gAMA | **STRIP** | Color profile and rendering fingerprints. |
| pHYs | **STRIP** | Physical pixel dimensions. |
| sPLT | **STRIP** | Suggested palette fingerprint. |
| bKGD, hIST | **STRIP** | Misc rendering/fingerprintable hints. |
| IHDR, IDAT, IEND, other unlisted chunks | Preserve | Image data and non-listed container chunks. |

### WebP

| Chunk | Action | Rationale |
|---|---|---|
| EXIF | **STRIP** | EXIF metadata. |
| XMP | **STRIP** | XMP metadata. |
| ICCP | **STRIP** | Color profile. |
| VP8X metadata flags | **CLEAR** | Header must not advertise stripped EXIF/XMP/ICC chunks. |
| VP8/VP8L/VP8X image data, alpha/animation chunks | Preserve | Image data and non-metadata structure. |

### HEIC / AVIF

| Action | Rationale |
|---|---|
| Strip ISO-BMFF metadata carriers before encryption/TUS for supported AVIF/HEIC/HEIF originals. Canvas-reencoded AVIF originals remain metadata-clean by construction and may bypass stripping. | R-M1/R-M2 added bounded ISO-BMFF parsing and metadata item removal while preserving `mdat` image bytes. |

### Video (MP4, MOV, WebM, Matroska)

| Action | Rationale |
|---|---|
| Strip supported video metadata before encryption/TUS via `strip_video_metadata`. MP4/MOV remove `udta` and `meta` metadata boxes while preserving `mdat`; WebM/Matroska remove `Tags` and `Attachments` while preserving `Cluster`. | R-M6 adds bounded ISO-BMFF and EBML container parsing for video; no frame re-encoding occurs. Cross-platform parity is verified by corpus goldens as wrappers expose the same Rust core. |

## Cross-platform parity rule

All clients (web TS via WASM and Rust core) MUST produce byte-identical post-strip output for the same input. Android Kotlin obtains stripped bytes transitively via `generate_tiers_*`; the parity guarantee is internal to the Rust call path and does not require a separate Android corpus test until the Android client adds a strip path that bypasses `generate_tiers_*`. M0 locks a shared corpus in `apps/web/tests/fixtures/strip-corpus/`: web WASM tests and native Rust tests both compare post-strip bytes and removed-carrier counts against the same golden files.

If a future Android caller strips outside `generate_tiers_*`, file a new ticket to expose `strip_known_metadata` through UniFFI and add an Android-side corpus parity test.

## Zero-Knowledge Invariants

- Stripping runs entirely on the client before upload encryption.
- The backend receives only encrypted shard bytes and never receives plaintext media or metadata.
- WASM FFI carries client-local media plaintext, not keys or secrets. `StripResult` Debug prints byte lengths/counts only.
- No stripped or original media bytes are logged.
- The new WASM exports do not expose raw keys, seeds, passwords, or secret handles.

## Component Tree

```text
tiered-upload-handler.ts
  -> stripExifFromBlob(blob, mimeType)
       -> MIME gate: JPEG / PNG / WebP / explicit unsupported formats
       -> generated mosaic_wasm init
       -> strip{Jpeg,Png,Webp}Metadata(inputBytes)
            -> crates/mosaic-wasm
                 -> mosaic_media::strip_known_metadata(format, bytes)
```

## Verification Plan

- `crates/mosaic-wasm` API-shape lock includes `StripResult` and the three strip exports.
- `apps/web/src/lib/__tests__/exif-stripper.test.ts` verifies web delegation, never-throws fallback, malformed mapping, and HEIC/AVIF/video rejection classification.
- `apps/web/src/lib/upload/__tests__/tiered-upload-handler-metadata.test.ts` verifies fail-closed upload behavior before encryption/TUS.
- `apps/web/tests/strip-parity.test.ts` loads generated WASM bytes and compares JPEG/PNG/WebP output against golden corpus files.
- `crates/mosaic-media/tests/strip_corpus.rs` reads the same web corpus/goldens and asserts native Rust output bytes and removed counts match.
- Architecture guards verify Rust crate dependency boundaries and raw-secret FFI constraints.

## Forward links

- R-M1 (AVIF strip) - landed; source-preserved AVIF uses bounded ISO-BMFF strip.
- R-M2 (HEIC strip) - landed; source-preserved HEIC/HEIF uses bounded ISO-BMFF strip.
- R-M6 (video strip) - landed; MP4/MOV/WebM/Matroska use `strip_video_metadata`.
- M0 - current SPEC anchor.
