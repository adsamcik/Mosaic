# ADR-017: Sidecar tag registry policy

## Status

Accepted. Closes plan v2 ticket R-M5 governance question. Governs every sidecar tag allocation in `crates/mosaic-domain/src/lib.rs::metadata_field_tags`.

## Context

Mosaic's encrypted metadata sidecar (`Mosaic_Metadata_v1`, 64-byte version envelope + TLV body) preserves recognized image/video metadata that has been stripped from gallery tier bytes. Each preserved field is identified by a `u16` tag number drawn from a registry currently scattered across:

- the `metadata_field_tags` Rust module (constants),
- prose in `SPEC-RustEncryptedMetadataSidecar.md`,
- the encoded fields produced by `canonical_media_metadata_sidecar_bytes` and consumed by web/Android.

Tags 1 (orientation), 2 (original_dimensions), 3 (device_timestamp_ms), 4 (mime_override), 5 (camera_make), 7 (camera_model), 8 (subseconds_ms), and 9 (gps) are active v1 image-class sidecar tags after R-M3/R-M4. The Rust core completion programme also reserves:

- tag 10 (codec_fourcc, R-M7),
- tag 11 (duration_ms, R-M7),
- tag 12 (frame_rate_x100, R-M7),
- tag 13 (video_orientation, R-M7).

The 3-reviewer pass (`files/reviews/R3-opus47-coherence.md`) flagged that **once a sidecar tag number is written into encrypted bytes that ship to a user's device, the (tag → meaning, layout) mapping is forever-frozen** — exactly like a `ClientErrorCode` numeric or an envelope version. Without governance:

- two parallel implementations (Rust media-core vs platform fallback) could allocate the same number for different fields,
- a future version could redefine an existing tag's layout, breaking decryption of sidecars from older clients,
- a deprecated tag could be silently dropped from the registry while encrypted sidecars on user devices still reference it.

ADR-005 (crypto deps), ADR-008 (media gate), and ADR-006 (FFI handles) implicitly assumed a registry; this ADR makes the policy explicit.

## Decision

Sidecar tag numbers are governed by an **append-only, lock-tested, ADR-changeable registry** documented in a new SPEC `docs/specs/SPEC-CanonicalSidecarTags.md` and pinned by a Rust lock test `crates/mosaic-domain/tests/sidecar_tag_table.rs` mirroring `error_code_table.rs`.

### Registry rules

1. **Append-only allocation.** Every new tag gets the next available `u16` value. Existing tags' (number, name, layout) tuples are immutable.
2. **No re-use.** A removed tag is **deprecated, not deleted**: the registry retains an entry marked `Deprecated { since_version, replacement?: u16 }`. The `u16` value is permanently reserved.
3. **Layout is part of the contract.** Every tag entry specifies: TLV body byte layout (with endianness), value range / validity rules, presence semantics (optional, conditional, required), encoding format (UTF-8 NFC, fixed binary, etc.), max byte length cap.
4. **No tag may carry plaintext content** that is not already part of the v1 sidecar privacy classes (orientation, dimensions, MIME, GPS, timestamps, camera identity, video codec). All sidecar TLV bytes are encrypted before server transit; per-tag privacy classes are registry metadata describing client-local plaintext sensitivity for future redaction, logging, and platform handling. They are not currently a runtime-enforced redaction hook. New privacy classes require a separate ADR amending `SPEC-LateV1ProtocolFreeze.md` §"Frozen now" item 5.
5. **No tag may carry secret material** (keys, password hashes, biometric data, account identifiers, raw URIs, file names). Tag 6 remains numerically reserved as `filename`, but filenames are forbidden payloads and producers must not emit that tag. Encoders reject `Forbidden` tags with `MetadataSidecarError::ForbiddenTag`, distinct from `ReservedNumberPending` tags rejected as `ReservedTagNotPromoted`. The R-M5.3 decoder target includes a defense-in-depth forbidden-name check before any decoder becomes a v1 invariant.
6. **Cross-implementation consistency.** Native Rust, WASM (P-W2), and UniFFI (P-U1) all consume the same numeric registry; cross-wrapper byte-equality tests (Q-final-1) include sidecar bytes for every supported tag combination.
7. **Total sidecar cap.** `MAX_SIDECAR_TOTAL_BYTES` is locked at `65_536` bytes (64 KiB) for v1 by R-M5.2.2. The current active-tag worst case after R-M3/R-M4 is 281 bytes (`59 + (8 * 6) + 2 + 8 + 8 + 10 + 64 + 64 + 4 + 14`), so 64 KiB provides large headroom while reducing the allocation/DoS surface from the provisional R-M5.2.1 `1_500_000` byte (1.5 MB) value. Tightening or relaxing the cap after v1 freeze is protocol-visible; a future Active tag that cannot fit must be redesigned or deferred to a v2 breaking cap relaxation with migration handlers.

### Lock test (`sidecar_tag_table.rs`)

```rust
const REGISTRY_V1: &[(u16, &str, TagLayout, TagStatus)] = &[
    (1, "orientation", TagLayout::U16Le { range: 1..=8 }, TagStatus::Active),
    (2, "original_dimensions", TagLayout::DimensionsLe, TagStatus::Active),
    (3, "device_timestamp_ms", TagLayout::U64LeUnixMillis, TagStatus::Active),
    (4, "mime_override", TagLayout::Utf8BytesNoRegistryCapU32Length { byte_exact: true }, TagStatus::Active),
    (5, "camera_make", TagLayout::Utf8Bytes { max_bytes: 64 }, TagStatus::Active),
    (6, "filename", TagLayout::ForbiddenReservedPayload, TagStatus::Forbidden),
    (7, "camera_model", TagLayout::Utf8Bytes { max_bytes: 64 }, TagStatus::Active),
    (8, "subseconds_ms", TagLayout::U32LeRange { min: 0, max: 999 }, TagStatus::Active),
    (9, "gps", TagLayout::PackedGpsMicrodegrees, TagStatus::Active),
    (10, "codec_fourcc", TagLayout::ReservedAwaitingLayout, TagStatus::ReservedNumberPending),
    (11, "duration_ms", TagLayout::ReservedAwaitingLayout, TagStatus::ReservedNumberPending),
    (12, "frame_rate_x100", TagLayout::ReservedAwaitingLayout, TagStatus::ReservedNumberPending),
    (13, "video_orientation", TagLayout::ReservedAwaitingLayout, TagStatus::ReservedNumberPending),
];

#[test]
fn registry_is_append_only() {
    // Asserts no entry has changed (number, name, status) tuple,
    // no entry was removed, and any new entry is at the next free slot.
}
```

Tag *numbers* are locked by this ADR and by `sidecar_tag_table.rs`; *byte layouts* for tags marked `ReservedNumberPending` are finalized by their corresponding R-M ticket and are not normative until that ticket merges with golden vectors. Until then, `ReservedAwaitingLayout` means the number is allocated, but producers must not emit the tag and decoders must not treat a concrete layout as frozen. Tags marked `Forbidden` are permanently blocked by policy; production encoders report `ForbiddenTag` rather than `ReservedTagNotPromoted` so telemetry can distinguish permanent rejection from "awaiting ADR promotion." The corresponding ticket remains documented in the canonical SPEC row notes.

### Reserved tag-number ranges

- **0** is reserved (signal "absent" in some contexts; never allocated).
- **1–4** are v1.0 image-class tags (already shipped).
- **5–9** are R-M3/R-M4 image-extension allocations except tag 6, which remains permanently forbidden as `filename`.
- **10–13** are this programme's video-class allocations (R-M7).
- **14–127** are reserved for media-class extensions (image, video, audio if added).
- **128–255** are reserved for future "non-media" structured fields (not used in v1).
- **256–4095** are reserved for vendor / experimental tags; allocated only with an ADR.
- **4096–32767** are reserved for future protocol extensions; never allocated without a major version bump.
- **32768–65535** (high-bit set, `tag & 0x8000 != 0`) are reserved for future "skippable optional" tags whose decoder behavior is "ignore unknown high-bit tags" rather than `SidecarTagUnknown`. **No v1 ADR allocates in this range.** Reserved for v2+ wire-evolution support.

The two reserved ranges (4096–32767 and 32768–65535) were inadvertently overlapping in earlier drafts; this allocation explicitly separates them. The high-bit decode rule (rule §4.1 below) applies only to numbers ≥ 32768; numbers in 4096–32767 remain hard-rejected as `SidecarTagUnknown` until an ADR allocates.

### Decode validation (defense in depth)

These rules describe target decoder behavior. R-M5.2 shipped registry correctness follow-ups in `5d42e5a`; the deferred decoder and fuzz harness are now tracked separately as R-M5.3. Until R-M5.3 implements a decoder, the rules are forward-looking design specifications, not enforceable invariants. Encoders still enforce the active/reserved/forbidden registry status before writing sidecar bytes.

Sidecar decoders must:

1. Reject TLV records whose tag is **unknown to the running client**, *unless* the tag's high bit (`tag & 0x8000 != 0`) marks it as "skippable optional" — reserved for future evolution; never used in v1. Skippable-optional decode policy is "skip TLV record, continue parsing, do not raise an error"; this contrasts with the hard rejection for any unknown numeric tag below 32768.
2. Reject TLV records whose declared length exceeds the registry's documented max for that tag. Returns `SidecarFieldOverflow`.
3. Reject TLV records whose body fails per-tag validation (orientation ∉ 1..=8, GPS lat/lon out of range, UTF-8 invalid, dimensions zero, etc.). Returns `MalformedSidecar`.
4. Treat duplicate tags within one sidecar as `MalformedSidecar` (no last-wins, no merge — explicit rejection). Lock test asserts decoder behavior on a duplicate-tag fixture.
5. Reject any TLV body containing forbidden field-name patterns (defense-in-depth against accidental schema corruption that produces well-formed-but-secret-bearing bytes).

### UTF-8 length cap behavior

UTF-8 fields (`Utf8Nfc { max_bytes: 64 }` style) reject inputs whose UTF-8 byte length **strictly exceeds** the cap with `SidecarFieldOverflow`. The producer side must truncate **at character boundaries** before encoding, never at byte boundaries (avoids producing invalid UTF-8 mid-multi-byte). Truncation policy is producer-side; the encoder fails-closed if the producer hands it invalid UTF-8.

Tag 4 (`mime_override`) is the active v1 exception: R-M5.2 locks the shipped byte-exact layout as `Utf8BytesNoRegistryCapU32Length`, with no retroactive NFC normalization or 64-byte cap. Cross-platform encoders must preserve tag 4 bytes exactly.

### ADR amendment workflow

Allocating a new tag requires:
1. A new ADR (or an amendment to this ADR) specifying tag number, name, layout, validation rules, leakage classification, and cross-platform consumption.
2. The lock test updated (append-only).
3. Golden vectors for the new tag added to `tests/vectors/sidecar/`.
4. Native Rust, WASM, and UniFFI implementations land together; partial allocations are forbidden.

Deprecating a tag requires:
1. A new ADR documenting the deprecation reason and replacement plan.
2. The registry entry flipped to `Deprecated { since_version, replacement?: u16 }`.
3. Old clients continue to decode it; new clients refuse to encode it.
4. The numeric value is permanently reserved.

## Options Considered

### Implicit registry, no policy

- Pros: zero ADR overhead.
- Cons: silent drift between platforms; no append-only guarantee; tag re-use possible by accident; no audit trail.
- Conviction: 1/10.

### String-keyed sidecar (no numeric tags)

- Pros: human-readable; "self-documenting"; trivial to add fields.
- Cons: bigger bytes; canonical encoding harder; introduces an allocation surface (which strings are valid?); no improvement over governance.
- Conviction: 3/10.

### Append-only numeric registry with lock test + ADR allocation (this decision)

- Pros: matches the existing `error_code_table.rs` pattern; CI-enforced; cross-platform byte-equality is testable; deprecation is explicit; reserved-range policy bounds future evolution.
- Cons: each new field requires an ADR (small overhead).
- Conviction: 9/10.

### Versioned per-platform registries

- Pros: each platform evolves independently.
- Cons: directly contradicts the "single source of truth" invariant; sidecar bytes would diverge across platforms.
- Conviction: 1/10.

## Consequences

- New SPEC `docs/specs/SPEC-CanonicalSidecarTags.md` documents the registry, layouts, and reserved ranges.
- New lock test `crates/mosaic-domain/tests/sidecar_tag_table.rs` mirrors `error_code_table.rs`.
- R-M3, R-M4, R-M7 each convert their `ReservedNumberPending` entries into active layouts with a lock-test update and golden vectors.
- The decode validator returns `SidecarFieldOverflow`, `MalformedSidecar`, or `SidecarTagUnknown` for the failure classes above (allocated under R-C1).
- ADR-022 (manifest finalization) references this ADR for the encrypted-meta-sidecar opaque-bytes contract.
- WASM (P-W2) and UniFFI (P-U1) sidecar exports surface the same numeric tags by reference to this registry.
- Q-final-1 cross-platform byte-equality matrix includes sidecar bytes for every supported tag combination across the fixture matrix.
- Vendor / experimental tag range (256–4095) cannot be used without a corresponding ADR; static guard rejects unknown allocations.

## Reversibility

The registry policy itself is reversible (this ADR can be amended). The numeric allocations made under it are **not reversible**: tag numbers are forever reserved once allocated. For active tags, the (tag → layout) tuple is forever frozen by the lock test; for `ReservedNumberPending<TicketId>` tags, the byte layout becomes irreversible only when the corresponding R-M ticket merges with its golden vector. Deprecation preserves the numeric value; outright reuse is forbidden.
