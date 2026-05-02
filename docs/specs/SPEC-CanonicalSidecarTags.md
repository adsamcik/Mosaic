# SPEC: Canonical Sidecar Tag Registry

## Status

Locked at sidecar registry version v1.

This is the append-only human-readable registry for Mosaic metadata sidecar TLV tag numbers. It is mandated by [ADR-017: Sidecar tag registry policy](../adr/ADR-017-sidecar-tag-registry-policy.md) §"Decision" and §"Consequences" and is enforced in CI by `crates/mosaic-domain/tests/sidecar_tag_table.rs`.

Existing `(tag number, name, layout class, layout detail)` commitments are immutable once their layout class is `Active` in the lock test. Deprecated tags remain in this registry forever with their numeric value permanently reserved.

## Scope

This registry covers only the client-local canonical metadata sidecar TLV body identified by `Mosaic_Metadata_v1` and the `u16` field tags declared in `crates/mosaic-domain/src/lib.rs::metadata_field_tags`.

Out of scope:

- Manifest tier bytes (`tieredShards[].tier`) are a separate namespace. ADR-024 explicitly separates future video preview-tier allocation from ADR-017's sidecar tag-number registry (ADR-024 §"Manifest transcript convention").
- Shard envelope version bytes and magic values are governed by envelope and manifest ADRs, not this registry.
- Server JSON manifest field names are governed by ADR-022 and manifest SPECs. The server treats `encryptedMetaSidecar` as opaque encrypted bytes (ADR-022 §"Rules" item 9).

## Governance

- **ADR-017** is the governing policy for allocation, reserved ranges, decode validation, UTF-8 cap behavior, amendment workflow, and deprecation workflow (ADR-017 §"Decision").
- **ADR-022** binds `encryptedMetaSidecar` into the manifest transcript as encrypted sidecar envelope bytes and states that the TLV body is governed by ADR-017 while the backend treats the field as opaque bytes (ADR-022 §"Rules" item 9 and §"Cross-references").
- **ADR-024** reserves the video sidecar class for R-M7 and uses tag 10 `codec_fourcc` as the encrypted-sidecar video discriminator while keeping manifest tier bytes separate (ADR-024 §"Manifest transcript convention" and §"Sidecar contents (R-M7)").

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
- The backend never sees sidecar TLV plaintext; it receives only `encryptedMetaSidecar` opaque envelope bytes (ADR-022 §"POST /api/manifests request shape (frozen)" and §"Rules" item 9).

## TLV record encoding

The sidecar body is carried inside the canonical metadata sidecar envelope defined by [SPEC-RustEncryptedMetadataSidecar](SPEC-RustEncryptedMetadataSidecar.md) §"Canonical binary format". Within that envelope, each field record is encoded exactly as follows:

```text
byte offset  size          field
0            2 bytes       tag: u16 little-endian
2            4 bytes       length: u32 little-endian
6            length bytes  body/value bytes
```

All integers are little-endian. The `length` field is the byte length of the body and is serialized as `u32`; builders reject field values whose length cannot fit in `u32`.

This record layout is locked by `crates/mosaic-domain/src/lib.rs::canonical_metadata_sidecar_bytes` and verified by the manifest sidecar tests. The surrounding sidecar envelope contributes the `Mosaic_Metadata_v1` context, format version, album ID, photo ID, epoch ID, and field count; the TLV records above are repeated `field_count` times.

## Tag registry table

Leakage class for every allocated or reserved tag below is: **server-visible? never**. Sidecar TLV contents are encrypted before transit; the server stores only opaque encrypted envelope bytes.

`Status` is normative and must exactly match the `LayoutClass` value pinned in `crates/mosaic-domain/tests/sidecar_tag_table.rs`:

- `Active`: tag number, name, layout class, and layout detail are finalized and immutable.
- `ReservedAwaitingLayout`: tag number and name are reserved; a future ADR/ticket must finalize layout details before production encoding expands to that field.
- `ReservedRange`: boundary or range marker reserved by ADR-017; not a concrete TLV field allocation.

| Tag # | Name | Status | Layout summary | Leakage class | First-allocation ADR / SPEC | Notes |
|---:|---|---|---|---|---|---|
| 0 | reserved_zero | ReservedRange | Never a TLV field tag; rejected as zero field tag. | Server-visible? never | ADR-017 §"Reserved tag-number ranges" | May be used as an absent sentinel only outside allocated TLV records. |
| 1 | orientation | Active | `u16` little-endian EXIF orientation, valid range `1..=8`. Presence optional; omit when unknown. | Server-visible? never | ADR-017 §"Lock test (`sidecar_tag_table.rs`)"; `metadata_field_tags::ORIENTATION` | Layout detail pinned as `U16LeExifOrientationRange1To8`. |
| 2 | device_timestamp_ms | ReservedAwaitingLayout | Layout finalized by R-M4 / future ADR. Planned layout from R-M4: `i64 LE Unix ms \| i16 LE timezone_offset_min \| u16 LE subsecond_ms`. Presence optional; omit when unavailable. | Server-visible? never | ADR-017 §"Context"; plan §3.2 R-M4 | R-M4 promotes this row to `Active` when layout tests land. |
| 3 | original_dimensions | Active | Width `u32` little-endian followed by height `u32` little-endian. Both dimensions must be non-zero. Presence optional; expected for supported media when known. | Server-visible? never | ADR-017 §"Lock test (`sidecar_tag_table.rs`)"; `metadata_field_tags::ORIGINAL_DIMENSIONS` | Layout detail pinned as `U32LeWidthThenHeightNonZero`. |
| 4 | mime_override | Active | UTF-8 bytes emitted/consumed by v1 as the trusted MIME override. The shipped `mosaic-domain` sidecar builder applies no tag-specific `max_bytes` cap; the body is bounded only by the TLV `length: u32` field and the non-empty field rule. The v1 media producer emits canonical `MediaFormat` MIME strings such as `image/jpeg`, `image/png`, and `image/webp`. | Server-visible? never | ADR-017 §"Lock test (`sidecar_tag_table.rs`)"; `metadata_field_tags::MIME_OVERRIDE`; `canonical_metadata_sidecar_bytes` | Layout detail pinned as `Utf8BytesNoRegistryCapU32Length`; no stricter cap is retroactively introduced by this SPEC. |
| 5 | caption | ReservedAwaitingLayout | Layout finalized by future ADR. Currently reserved for user caption UTF-8 bytes. Presence optional; omit when absent. | Server-visible? never | ADR-017 §"Reserved tag-number ranges"; `metadata_field_tags::CAPTION` | Numeric constant exists as a reserved-name placeholder; layout not yet locked. |
| 6 | filename | ReservedAwaitingLayout | Layout finalized by future ADR. Currently reserved for original filename UTF-8 bytes. Presence optional; omit when absent. | Server-visible? never | ADR-017 §"Reserved tag-number ranges"; `metadata_field_tags::FILENAME` | Numeric constant exists as a reserved-name placeholder. ADR-017 §"Registry rules" item 5 forbids raw URIs and account identifiers. |
| 7 | camera_make | ReservedAwaitingLayout | Layout finalized by R-M4 / future ADR. Planned layout from R-M4: UTF-8, NFC, explicit byte cap 64, non-UTF-8 rejected. Presence optional; omit when absent. | Server-visible? never | ADR-017 §"Context"; plan §3.2 R-M4 | R-M4 promotes this row to `Active` when layout tests land. |
| 8 | camera_model | ReservedAwaitingLayout | Layout finalized by R-M4 / future ADR. Planned layout from R-M4: UTF-8, NFC, explicit byte cap 64, non-UTF-8 rejected. Presence optional; omit when absent. | Server-visible? never | ADR-017 §"Context"; plan §3.2 R-M4 | R-M4 promotes this row to `Active` when layout tests land. |
| 9 | gps | ReservedAwaitingLayout | Layout finalized by R-M3 / future ADR. Planned layout from R-M3: `f64 LE lat \| f64 LE lon \| f64 LE alt_m \| i64 LE timestamp_unix_ms \| u8 presence_bitmap`, absent fields zeroed and ignored; reject NaN/Inf, latitude outside `[-90,90]`, longitude outside `[-180,180]`. Presence optional; omit when no GPS metadata is preserved. | Server-visible? never | ADR-017 §"Context"; plan §3.2 R-M3 | R-M3 promotes this row to `Active` when layout tests land. |
| 10 | codec_fourcc | ReservedAwaitingLayout | Reserved for R-M7 video sidecar. Planned layout from R-M7 / ADR-024: `u32` little-endian FourCC. Presence conditional: video assets only. | Server-visible? never | ADR-017 §"Context"; ADR-024 §"Sidecar contents (R-M7)"; plan §3.2 R-M7 | Acts as encrypted-sidecar video discriminator per ADR-024 §"Manifest transcript convention". No `mosaic-domain` constant is added by R-M5. |
| 11 | duration_ms | ReservedAwaitingLayout | Reserved for R-M7 video sidecar. Planned layout: `u64` little-endian duration in milliseconds. Presence conditional: video assets only. | Server-visible? never | ADR-017 §"Context"; ADR-024 §"Sidecar contents (R-M7)"; plan §3.2 R-M7 | No `mosaic-domain` constant is added by R-M5. |
| 12 | frame_rate_x100 | ReservedAwaitingLayout | Reserved for R-M7 video sidecar. Planned layout: `u16` little-endian frame rate multiplied by 100. Presence conditional: video assets only when known. | Server-visible? never | ADR-017 §"Context"; ADR-024 §"Sidecar contents (R-M7)"; plan §3.2 R-M7 | No `mosaic-domain` constant is added by R-M5. |
| 13 | video_orientation | ReservedAwaitingLayout | Reserved for R-M7 video sidecar. Planned layout: orientation byte plus reserved zero byte per R-M7; valid orientation range to be finalized by R-M7. Presence conditional: video assets only when non-default or known. | Server-visible? never | ADR-017 §"Context"; ADR-024 §"Sidecar contents (R-M7)"; plan §3.2 R-M7 | No `mosaic-domain` constant is added by R-M5. |

## Reserved tag-number ranges

| Range | Status | Allocation policy | Source |
|---|---|---|---|
| `0` | ReservedRange | Never allocated. | ADR-017 §"Reserved tag-number ranges" |
| `1..=4` | Active | Existing v1 image-class tags. Existing active tuples immutable. | ADR-017 §"Reserved tag-number ranges" |
| `5..=6` | ReservedAwaitingLayout | Caption / filename slots; layouts finalized by future ADR before promotion to `Active` layout class. | ADR-017 §"Reserved tag-number ranges" |
| `7..=9` | ReservedAwaitingLayout | R-M3 / R-M4 image-extension allocations. | ADR-017 §"Reserved tag-number ranges" |
| `10..=13` | ReservedAwaitingLayout | Video-class allocation: codec, duration, frame rate, video orientation. | ADR-017 §"Reserved tag-number ranges"; ADR-024 §"Sidecar contents (R-M7)" |
| `14..=127` | ReservedRange | Media-class extensions: image, video, audio if added. | ADR-017 §"Reserved tag-number ranges" |
| `128..=255` | ReservedRange | Future non-media structured fields; not used in v1. | ADR-017 §"Reserved tag-number ranges" |
| `256..=4095` | ReservedRange | Vendor / experimental tags; allocated only with an ADR. | ADR-017 §"Reserved tag-number ranges" |
| `4096..=32767` | ReservedRange | Future protocol extensions; never allocated without a major version bump. Unknown tags in this range are hard-rejected in v1. | ADR-017 §"Reserved tag-number ranges" |
| `32768..=65535` | ReservedRange | High-bit-set skippable optional tags for future v2+ wire evolution. No v1 ADR allocates here. | ADR-017 §"Reserved tag-number ranges" |

The `4096..=32767` and `32768..=65535` ranges are deliberately disjoint. ADR-017 notes earlier drafts accidentally overlapped these ranges and now limits the high-bit skippable rule to numbers `>= 32768` (ADR-017 §"Reserved tag-number ranges").

## Decode validation

Sidecar decoders must implement ADR-017 §"Decode validation (defense in depth)":

1. Reject TLV records whose tag is unknown to the running client unless the tag's high bit (`tag & 0x8000 != 0`) marks it as future skippable optional. Skippable optional tags are ignored and parsing continues; unknown tags below `32768` hard-reject as `SidecarTagUnknown`.
2. Reject TLV records whose declared length exceeds the registry maximum for that tag. Return `SidecarFieldOverflow`.
3. Reject TLV bodies that fail per-tag validation, including orientation outside `1..=8`, GPS coordinate range failures, invalid UTF-8, or zero dimensions. Return `MalformedSidecar`.
4. Reject duplicate tags within one sidecar as `MalformedSidecar`; no last-wins or merge behavior.
5. Reject TLV bodies containing forbidden field-name patterns as defense in depth against accidental schema corruption that produces well-formed but secret-bearing bytes.

## UTF-8 length cap behavior

UTF-8 fields with an explicit registry cap reject inputs whose UTF-8 byte length strictly exceeds the tag cap with `SidecarFieldOverflow` (ADR-017 §"UTF-8 length cap behavior").

Producer-side truncation, when a producing layer chooses to truncate user-facing strings before encoding, must occur at character boundaries and must never cut a multi-byte UTF-8 sequence. The encoder fails closed if handed invalid UTF-8 or a value above the cap.

Tag 4 (`mime_override`) is an active v1 exception to the explicit-cap examples in ADR-017: the shipped Rust sidecar builder has no tag-specific MIME cap, so R-M5 locks the de facto TLV `u32` body-length bound rather than inventing a retroactive `max_bytes` value.

## Forward links

- **R-M3 — tag 9 (`gps`)**: pins the GPS binary layout, finite-coordinate validation, presence bitmap semantics, and overflow/NaN rejection before promoting tag 9 to `Active`.
- **R-M4 — tags 2, 7, 8 (`device_timestamp_ms`, `camera_make`, `camera_model`)**: pins timestamp and camera string layouts, UTF-8/NFC validation, byte caps where applicable, and producer omission rules before promoting these tags to `Active`.
- **R-M7 — tags 10, 11, 12, 13 (`codec_fourcc`, `duration_ms`, `frame_rate_x100`, `video_orientation`)**: pins video sidecar layouts and validation rules before promoting video-class rows to `Active`.
- **Deferred — tags 5, 6 (`caption`, `filename`)**: explicitly deferred per ADR-017 §"Reserved tag-number ranges"; no R-M ticket in this programme allocates or promotes these layouts.

## Cross-platform consumption rules

- Native Rust, WASM, and UniFFI all consume this same numeric registry (ADR-017 §"Registry rules" item 6).
- Cross-wrapper byte equality for sidecar bytes is enforced by Q-final-1: sidecar bytes must be byte-equal across Rust/WASM/UniFFI for every supported image and video format (plan §10 Q-final-1).
- Q-final-1 includes sidecar bytes for video tags 10-13 when R-M7 lands (ADR-024 §"Sidecar contents (R-M7)" and §"Consequences").
- The backend remains outside the sidecar plaintext trust boundary and stores only encrypted envelope bytes.

