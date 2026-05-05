# SPEC: Canonical Sidecar Tag Registry

## Status

Locked at sidecar registry version v1.

This is the append-only human-readable registry for Mosaic metadata sidecar TLV tag numbers. It is mandated by [ADR-017: Sidecar tag registry policy](../adr/ADR-017-sidecar-tag-registry-policy.md) Â§"Decision" and Â§"Consequences" and is enforced in CI by `crates/mosaic-domain/tests/sidecar_tag_table.rs`.

Existing `(tag number, name, layout class, layout detail)` commitments are immutable once their layout class is `Active` in the lock test. Deprecated tags remain in this registry forever with their numeric value permanently reserved.

## Scope

This registry covers only the client-local canonical metadata sidecar TLV body identified by `Mosaic_Metadata_v1` and the `u16` field tags declared in `crates/mosaic-domain/src/lib.rs::metadata_field_tags`.

Out of scope:

- Manifest tier bytes (`tieredShards[].tier`) are a separate namespace. ADR-024 explicitly separates future video preview-tier allocation from ADR-017's sidecar tag-number registry (ADR-024 Â§"Manifest transcript convention").
- Shard envelope version bytes and magic values are governed by envelope and manifest ADRs, not this registry.
- Server JSON manifest field names are governed by ADR-022 and manifest SPECs. The server treats `encryptedMetaSidecar` as opaque encrypted bytes (ADR-022 Â§"Rules" item 9).

## Governance

- **ADR-017** is the governing policy for allocation, reserved ranges, decode validation, UTF-8 cap behavior, amendment workflow, and deprecation workflow (ADR-017 Â§"Decision").
- **ADR-022** binds `encryptedMetaSidecar` into the manifest transcript as encrypted sidecar envelope bytes and states that the TLV body is governed by ADR-017 while the backend treats the field as opaque bytes (ADR-022 Â§"Rules" item 9 and Â§"Cross-references").
- **ADR-024** reserves the video sidecar class for R-M7 and uses tag 10 `codec_fourcc` as the encrypted-sidecar video discriminator while keeping manifest tier bytes separate (ADR-024 Â§"Manifest transcript convention" and Â§"Sidecar contents (R-M7)").

Allocation workflow:

1. Every new tag requires a new ADR or an amendment to ADR-017 specifying tag number, name, byte layout, validation rules, leakage classification, and cross-platform consumption.
2. The tag is appended to this SPEC.
3. `crates/mosaic-domain/tests/sidecar_tag_table.rs` is updated append-only.
4. Golden vectors are added under `tests/vectors/sidecar/`.
5. Native Rust, WASM, and UniFFI implementations consume the same numeric registry.

Deprecation workflow:

1. A new ADR documents the reason and replacement plan.
2. This registry entry is flipped to `Deprecated { since_version, replacement?: u16 }`.
3. Old clients continue to decode the deprecated tag.
4. New clients refuse to encode the deprecated tag.
5. The numeric value is permanently reserved and never reused.

## Registry invariants

- Tags are `u16` values encoded little-endian in each sidecar TLV record.
- Tag `0` is never allocated.
- Allocated tags are append-only.
- A tag's layout includes endianness, encoding, value range, presence semantics, and maximum byte length when a maximum exists.
- Sidecar contents are plaintext only inside the client-local metadata pipeline and must be encrypted before manifest binding or transit (`canonical_metadata_sidecar_bytes` documents this in `crates/mosaic-domain/src/lib.rs`).
- The backend never sees sidecar TLV plaintext; it receives only `encryptedMetaSidecar` opaque envelope bytes (ADR-022 Â§"POST /api/manifests request shape (frozen)" and Â§"Rules" item 9).

## TLV record encoding

The sidecar body is carried inside the canonical metadata sidecar envelope defined by [SPEC-RustEncryptedMetadataSidecar](SPEC-RustEncryptedMetadataSidecar.md) Â§"Canonical binary format". Within that envelope, each field record is encoded exactly as follows:

```text
byte offset  size          field
0            2 bytes       tag: u16 little-endian
2            4 bytes       length: u32 little-endian
6            length bytes  body/value bytes
```

All integers are little-endian. The `length` field is the byte length of the body and is serialized as `u32`; builders reject field values whose length cannot fit in `u32`.

This record layout is locked by `crates/mosaic-domain/src/lib.rs::canonical_metadata_sidecar_bytes` and verified by the manifest sidecar tests. The surrounding sidecar envelope contributes the `Mosaic_Metadata_v1` context, format version, album ID, photo ID, epoch ID, and field count; the TLV records above are repeated `field_count` times.

## Tag registry table

All sidecar tags are encrypted before any server transit and are therefore not server-visible. The Privacy class column classifies *client-local plaintext* sensitivity for future redaction, logging, and platform-handling rules; in the current encoder it is registry metadata only and is not a runtime-enforced policy hook.

`Status` is normative and must exactly match the `SidecarTagStatus` value pinned in `crates/mosaic-domain/tests/sidecar_tag_table.rs`:

- `Active`: tag number, name, layout class, and layout detail are finalized and immutable.
- `ReservedNumberPending`: tag number and name are reserved; a future ADR/ticket must finalize layout details before production encoding expands to that field.
- `Forbidden`: tag number and name are permanently blocked by policy. Encoders reject the tag with `MetadataSidecarError::ForbiddenTag`, distinct from `ReservedTagNotPromoted` for `ReservedNumberPending` tags, so telemetry can distinguish permanent policy rejection from "awaiting ADR promotion."

Tag `0` is not a registry entry and is not represented by `SidecarTagStatus`; it is a permanently rejected sentinel documented only in the reserved range table.

| Tag # | Name | Status | Layout summary | Privacy class | First-allocation ADR / SPEC | Notes |
|---:|---|---|---|---|---|---|
| 1 | orientation | Active | `u16` little-endian EXIF orientation, valid range `1..=8`. Presence optional; omit when unknown. | `RenderingOnly` | ADR-017 Â§"Lock test (`sidecar_tag_table.rs`)"; `metadata_field_tags::ORIENTATION` | Layout detail pinned as `U16LeExifOrientationRange1To8`. |
| 2 | original_dimensions | Active | Width `u32` little-endian followed by height `u32` little-endian. Both dimensions must be non-zero. Presence optional; expected for supported media when known. | `RenderingOnly` | ADR-017 Â§"Lock test (`sidecar_tag_table.rs`)"; `metadata_field_tags::ORIGINAL_DIMENSIONS` | Layout detail pinned as `U32LeWidthThenHeightNonZero`. |
| 3 | device_timestamp_ms | Active | `u64` little-endian Unix timestamp milliseconds. EXIF timezone offsets, when present, are applied before encoding; no separate timezone tag exists. Presence optional; omit when unavailable or malformed. | `SensitiveTimestamp` | ADR-017 §"Context"; plan §3.2 R-M4 | R-M4 promotes this row to `Active`; malformed DateTime tags are skipped by the hostile EXIF parser. |
| 4 | mime_override | Active | Byte-exact UTF-8 bytes emitted/consumed by v1 as the trusted MIME override. Encoders must not apply NFC normalization to this active tag; cross-platform encoders must preserve caller-supplied bytes exactly. The shipped `mosaic-domain` sidecar builder applies no tag-specific `max_bytes` cap; the body is bounded only by `MAX_SIDECAR_TOTAL_BYTES = 65_536` (64 KiB), the TLV `length: u32` field, and the non-empty field rule. The v1 media producer emits canonical ASCII `MediaFormat` MIME strings such as `image/jpeg`, `image/png`, and `image/webp`. | `ContainerTechnical` | ADR-017 Â§"Lock test (`sidecar_tag_table.rs`)"; `metadata_field_tags::MIME_OVERRIDE`; `canonical_metadata_sidecar_bytes` | Layout detail pinned as `Utf8BytesNoRegistryCapU32Length`; no stricter tag-specific cap or normalization step is retroactively introduced by this SPEC. |
| 5 | camera_make | Active | UTF-8 bytes, maximum 64 bytes. Presence optional; omit when absent or malformed. | `DeviceFingerprint` | ADR-017 Â§"Context"; plan Â§3.2 R-M4; `metadata_field_tags::CAMERA_MAKE` | R-M4 promotes this row to `Active`; EXIF ASCII input is trimmed and capped before encoding. |
| 6 | filename | Forbidden | FORBIDDEN — see ADR-017 §"Registry rules" item 5. ADR-017 forbids filenames as sidecar payloads; no production encoder may serialize this tag. | `UserContent` | ADR-017 §"Registry rules" item 5; `sidecar_tag_table.rs::expected_and_live_tables_agree`; `sidecar_tag_table.rs::lock_test_for_every_forbidden_tag` | No `metadata_field_tags::FILENAME` public constant is exposed; tag number remains permanently forbidden and encoder dispatch is locked to `MetadataSidecarError::ForbiddenTag`. |
| 7 | camera_model | Active | UTF-8 bytes, maximum 64 bytes. Presence optional; omit when absent or malformed. | `DeviceFingerprint` | ADR-017 Â§"Context"; plan Â§3.2 R-M4; `metadata_field_tags::CAMERA_MODEL` | R-M4 promotes this row to `Active`; EXIF ASCII input is trimmed and capped before encoding. |
| 8 | subseconds_ms | Active | `u32` little-endian millisecond fraction, valid range `0..=999`. Presence optional; omit when absent or malformed. | `SensitiveTimestamp` | ADR-017 Â§"Context"; plan Â§3.2 R-M4; `metadata_field_tags::SUBSECONDS_MS` | R-M4 promotes this row to `Active`; oversized EXIF SubSecTime strings are rejected. |
| 9 | gps | Active | Packed 14-byte binary: latitude `i32` microdegrees, longitude `i32` microdegrees, altitude meters `i32`, accuracy meters `u16`, all little-endian. Latitude must be within `[-90_000_000, 90_000_000]`; longitude within `[-180_000_000, 180_000_000]`. Presence optional; omit when no valid GPS metadata is preserved. | `SensitiveLocation` | ADR-017 §"Context"; plan §3.2 R-M3; `metadata_field_tags::GPS` | R-M3 promotes this row to `Active`. Privacy class is informational; runtime enforcement is pending decoder work in R-M5.3. |
| 10 | codec_fourcc | Active | `u8` codec enum: `1=H264`, `2=H265`, `3=AV1`, `4=VP8`, `5=VP9`. Presence conditional: video assets only when codec is recognized. | `ContainerTechnical` | ADR-017 §"Context"; ADR-024 §"Sidecar contents (R-M7)"; plan §3.2 R-M7 | R-M7 promotes this row to `Active`; the name is retained from the reserved allocation, but the canonical body is the compact enum byte used by Rust/WASM/UniFFI. |
| 11 | duration_ms | Active | `u64` little-endian duration in milliseconds. Presence conditional: video assets only. | `ContainerTechnical` | ADR-017 §"Context"; ADR-024 §"Sidecar contents (R-M7)"; plan §3.2 R-M7 | R-M7 promotes this row to `Active`. |
| 12 | frame_rate_x100 | Active | `u32` little-endian milli-fps (`fps * 1000`, rounded). Presence conditional: video assets only when known. | `ContainerTechnical` | ADR-017 §"Context"; ADR-024 §"Sidecar contents (R-M7)"; plan §3.2 R-M7 | R-M7 promotes this row to `Active`; the reserved name remains append-only even though the finalized layout is milli-fps. |
| 13 | video_orientation | Active | `u8` rotation enum: `0=0°`, `1=90°`, `2=180°`, `3=270°`. Presence conditional: video assets only when transform metadata is present. | `RenderingOnly` | ADR-017 §"Context"; ADR-024 §"Sidecar contents (R-M7)"; plan §3.2 R-M7 | R-M7 promotes this row to `Active`. |
| 14 | video_dimensions | Active | Width `u32` little-endian followed by height `u32` little-endian. Both dimensions must be non-zero. Presence conditional: video assets only. | `RenderingOnly` | R-M7 | Appended by R-M7 because no earlier reserved row covered video dimensions. |
| 15 | video_container_format | Active | `u8` container enum: `1=MP4`, `2=MOV`, `3=WebM`, `4=Matroska`. Presence conditional: video assets only. | `ContainerTechnical` | R-M7 | Appended by R-M7 because no earlier reserved row covered container format. |

## Reserved tag-number ranges

| Range | Range class | Allocation policy | Source |
|---|---|---|---|
| `0` | Reserved sentinel | Never allocated; rejected before registry lookup as `ZeroFieldTag`. | ADR-017 Â§"Reserved tag-number ranges" |
| `1..=4` | Active | Existing v1 image-class tags. Existing active tuples immutable. | ADR-017 Â§"Reserved tag-number ranges" |
| `5..=9` | Active image-extension allocations plus forbidden filename | Tags 5, 7, 8, and 9 are Active R-M3/R-M4 EXIF-derived fields. Tag 6 is permanently `Forbidden` and cannot be promoted without a future ADR explicitly replacing that policy. | ADR-017 Â§"Reserved tag-number ranges"; ADR-017 §"Registry rules" item 5 |
| `10..=15` | Active video-class allocation range | Video codec, duration, frame rate, video orientation, dimensions, and container format promoted by R-M7. | ADR-017 §"Reserved tag-number ranges"; ADR-024 §"Sidecar contents (R-M7)" |
| `16..=127` | Unallocated reserved range | Media-class extensions: image, video, audio if added. | ADR-017 §"Reserved tag-number ranges" |
| `128..=255` | Unallocated reserved range | Future non-media structured fields; not used in v1. | ADR-017 Â§"Reserved tag-number ranges" |
| `256..=4095` | Unallocated reserved range | Vendor / experimental tags; allocated only with an ADR. | ADR-017 Â§"Reserved tag-number ranges" |
| `4096..=32767` | Unallocated reserved range | Future protocol extensions; never allocated without a major version bump. Unknown tags in this range are hard-rejected in v1. | ADR-017 Â§"Reserved tag-number ranges" |
| `32768..=65535` | Unallocated reserved range | High-bit-set skippable optional tags for future v2+ wire evolution. No v1 ADR allocates here. | ADR-017 Â§"Reserved tag-number ranges" |

The `4096..=32767` and `32768..=65535` ranges are deliberately disjoint. ADR-017 notes earlier drafts accidentally overlapped these ranges and now limits the high-bit skippable rule to numbers `>= 32768` (ADR-017 Â§"Reserved tag-number ranges").

## Decode validation (future decoder scope)

The decode validation rules below apply to the future sidecar decoder ticket (post-R-M5.1). Until that ticket lands, Mosaic does not implement a sidecar decoder; encoded sidecars are produced by Rust on the client side and consumed only by the encrypted-envelope wrap step. Cross-platform decode parity, fuzz-green gate inclusion (per ADR-020), and decoder error semantics are deferred.

R-M5.2 is complete at `5d42e5a` for registry correctness follow-ups. Decoder + fuzz harness + forbidden-name defense are tracked separately as R-M5.3 in plan §12 if and when sidecar decoding becomes a v1 requirement.

## UTF-8 length cap behavior

UTF-8 fields with an explicit registry cap reject inputs whose UTF-8 byte length strictly exceeds the tag cap with `SidecarFieldOverflow` (ADR-017 Â§"UTF-8 length cap behavior").

Producer-side truncation, when a producing layer chooses to truncate user-facing strings before encoding, must occur at character boundaries and must never cut a multi-byte UTF-8 sequence. The encoder fails closed if handed invalid UTF-8 or a value above the cap.

Tag 4 (`mime_override`) is an active v1 exception to the explicit-cap and NFC examples in ADR-017: the shipped Rust sidecar builder has no tag-specific MIME cap and preserves bytes exactly, so R-M5.2 locks the de facto TLV `u32` body-length bound plus `MAX_SIDECAR_TOTAL_BYTES` rather than inventing a retroactive `max_bytes` value or Unicode normalization step.

## Total sidecar byte cap

`MAX_SIDECAR_TOTAL_BYTES` is locked at `65_536` bytes (64 KiB) for v1 by R-M5.2.2. The current worst-case legitimate active-tag sidecar after R-M7 is 340 bytes: 59 bytes of fixed `Mosaic_Metadata_v1` envelope, fourteen 6-byte TLV record headers, and active values for orientation (2 bytes), original dimensions (8 bytes), device timestamp (8 bytes), MIME override (`image/jpeg`, 10 bytes), camera make (64 bytes), camera model (64 bytes), subseconds (4 bytes), GPS (14 bytes), video codec (1 byte), video duration (8 bytes), frame rate (4 bytes), video orientation (1 byte), video dimensions (8 bytes), and video container (1 byte). This leaves over 190× headroom for realistic v1 sidecars while reducing the allocation/DoS surface from the R-M5.2.1 provisional `1_500_000` byte (1.5 MB) cap. Tightening the cap after v1 freeze would be protocol-visible, so future Active tags must fit within 64 KiB or document a v2 breaking cap relaxation.

## Hostile EXIF parser defenses for tag 9

The R-M3 parser in `crates/mosaic-media` parses GPS before stripping EXIF and skips malformed GPS fields rather than panicking or preserving invalid coordinates. Defenses include: zero rational denominators reject the GPS field; coordinates outside valid latitude/longitude ranges are rejected; IFD pointer chasing is capped at four levels; IFD entry scans are capped by `MAX_TIFF_IFD_ENTRIES`; oversized EXIF strings are capped or skipped; truncated EXIF/JPEG boundaries return a clean non-panicking result. Tag 9 carries `SensitiveLocation`; this privacy class is informational registry metadata only until R-M5.3 decoder/runtime enforcement lands.

## Forward links

- **R-M3 â€” tag 9 (`gps`)**: pins the GPS binary layout, finite-coordinate validation, presence bitmap semantics, and overflow/NaN rejection before promoting tag 9 to `Active`.
- **R-M4 â€” tags 2, 7, 8 (`device_timestamp_ms`, `camera_make`, `camera_model`)**: pins timestamp and camera string layouts, UTF-8/NFC validation, byte caps where applicable, and producer omission rules before promoting these tags to `Active`.
- **R-M7 — tags 10, 11, 12, 13, 14, 15 (`codec_fourcc`, `duration_ms`, `frame_rate_x100`, `video_orientation`, `video_dimensions`, `video_container_format`)**: pins video sidecar layouts and validation rules and promotes video-class rows to `Active`.
- **Deferred â€” tags 5, 6 (`caption`, `filename`)**: explicitly deferred per ADR-017 Â§"Reserved tag-number ranges"; no R-M ticket in this programme allocates or promotes these layouts.

## Cross-platform consumption rules

- Native Rust, WASM, and UniFFI all consume this same numeric registry (ADR-017 Â§"Registry rules" item 6).
- Cross-wrapper byte equality for sidecar bytes is enforced by Q-final-1: sidecar bytes must be byte-equal across Rust/WASM/UniFFI for every supported image and video format (plan Â§10 Q-final-1).
- Q-final-1 includes sidecar bytes for video tags 10-15 after R-M7 (ADR-024 §"Sidecar contents (R-M7)" and §"Consequences").
- The backend remains outside the sidecar plaintext trust boundary and stores only encrypted envelope bytes.

