//! Late-v1 protocol freeze byte-format lock tests.
//!
//! These tests pin the byte-level constants that SPEC-LateV1ProtocolFreeze
//! lists under §"Frozen now" → "Shard envelope compatibility budget" and
//! §"Versioning and freeze gate rules" → "Opaque blob formats". They enumerate
//! the public domain constants by name and assert the exact byte values they
//! must hold for the v1 wire format. Any rename, value change, or accidental
//! removal of these constants trips the test.
//!
//! If any assertion in this file fails: a byte-format change after freeze
//! requires a new explicit version byte or context label, new positive and
//! negative vectors, dual-reader compatibility or migration plan, and proof
//! that old clients fail safely. Update SPEC-LateV1ProtocolFreeze §Frozen now
//! and add migration vectors under tests/vectors/ before changing the constant.

use mosaic_domain::{
    MANIFEST_SIGN_CONTEXT, MANIFEST_TRANSCRIPT_VERSION, METADATA_SIDECAR_CONTEXT,
    METADATA_SIDECAR_VERSION, MosaicDomainError, SHARD_ENVELOPE_HEADER_LEN, SHARD_ENVELOPE_MAGIC,
    SHARD_ENVELOPE_VERSION, ShardEnvelopeHeader, ShardTier,
};

const FREEZE_HINT: &str = "Late-v1 protocol freeze byte-format change — bump \
version + add migration vector + update SPEC-LateV1ProtocolFreeze §Frozen now \
before modifying this constant.";

const NONCE: [u8; 24] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
];

#[test]
fn shard_envelope_magic_is_frozen_at_sgzk_four_bytes() {
    assert_eq!(
        SHARD_ENVELOPE_MAGIC, *b"SGzk",
        "SHARD_ENVELOPE_MAGIC must be the four ASCII bytes `SGzk`. {FREEZE_HINT}"
    );
    assert_eq!(
        SHARD_ENVELOPE_MAGIC.len(),
        4,
        "SHARD_ENVELOPE_MAGIC must be exactly 4 bytes. {FREEZE_HINT}"
    );
    assert_eq!(
        SHARD_ENVELOPE_MAGIC,
        [0x53_u8, 0x47, 0x7a, 0x6b],
        "SHARD_ENVELOPE_MAGIC byte values must be 0x53,0x47,0x7a,0x6b (`SGzk`). \
         {FREEZE_HINT}"
    );
}

#[test]
fn shard_envelope_version_is_frozen_at_0x03() {
    assert_eq!(
        SHARD_ENVELOPE_VERSION, 0x03_u8,
        "SHARD_ENVELOPE_VERSION must be the single byte 0x03. {FREEZE_HINT}"
    );
}

#[test]
fn shard_envelope_header_total_length_is_frozen_at_64_bytes() {
    assert_eq!(
        SHARD_ENVELOPE_HEADER_LEN, 64_usize,
        "SHARD_ENVELOPE_HEADER_LEN must be exactly 64 bytes (the AAD covers the \
         whole header). {FREEZE_HINT}"
    );

    // Behavioural belt-and-suspenders: a freshly serialised header must really
    // serialise to 64 bytes. If the header layout drifts to anything other
    // than 64 bytes, this fails before any callers parse the result.
    let header = ShardEnvelopeHeader::new(0x0102_0304, 0x0506_0708, NONCE, ShardTier::Original);
    let bytes = header.to_bytes();
    assert_eq!(
        bytes.len(),
        64,
        "ShardEnvelopeHeader::to_bytes() must emit exactly 64 bytes. {FREEZE_HINT}"
    );
}

#[test]
fn shard_envelope_reserved_bytes_are_zero_on_encode() {
    // Reserved bytes occupy header offsets 38..64 (26 bytes total). They are
    // covered by the AAD — `bytes[38..64]` must be all zero on encode for every
    // tier. Decode-side enforcement is asserted in the decode test below.
    for &tier in &[
        ShardTier::Thumbnail,
        ShardTier::Preview,
        ShardTier::Original,
    ] {
        let header = ShardEnvelopeHeader::new(42, 7, NONCE, tier);
        let bytes = header.to_bytes();

        assert_eq!(
            bytes.len(),
            SHARD_ENVELOPE_HEADER_LEN,
            "header length drift on encode for tier {tier:?}. {FREEZE_HINT}"
        );

        for offset in 38..SHARD_ENVELOPE_HEADER_LEN {
            assert_eq!(
                bytes[offset], 0,
                "Reserved byte at offset {offset} must be zero on encode for \
                 tier {tier:?}. {FREEZE_HINT}"
            );
        }
    }
}

#[test]
fn shard_envelope_reserved_bytes_are_zero_checked_on_decode() {
    // For every reserved-byte offset (38..64), flipping that byte to a
    // non-zero value must cause decode to fail with NonZeroReservedByte at
    // that exact offset. This locks the decode-side enforcement of the
    // reserved-byte policy: a future change that silently ignores reserved
    // bytes would trip this test.
    for offset in 38..SHARD_ENVELOPE_HEADER_LEN {
        let mut bytes = ShardEnvelopeHeader::new(1, 1, NONCE, ShardTier::Thumbnail).to_bytes();
        bytes[offset] = 0x01;

        match ShardEnvelopeHeader::parse(&bytes) {
            Ok(header) => panic!(
                "Reserved byte at offset {offset} was non-zero but parse \
                 accepted the header: {header:?}. {FREEZE_HINT}"
            ),
            Err(MosaicDomainError::NonZeroReservedByte { offset: reported }) => {
                assert_eq!(
                    reported, offset,
                    "Decoder reported the wrong reserved-byte offset \
                     (expected {offset}, got {reported}). {FREEZE_HINT}"
                );
            }
            Err(other) => panic!(
                "Reserved byte at offset {offset} should fail with \
                 NonZeroReservedByte, got {other:?}. {FREEZE_HINT}"
            ),
        }
    }
}

#[test]
fn manifest_transcript_context_is_frozen_at_mosaic_manifest_v1() {
    assert_eq!(
        MANIFEST_SIGN_CONTEXT,
        b"Mosaic_Manifest_v1".as_slice(),
        "MANIFEST_SIGN_CONTEXT must equal the UTF-8 bytes `Mosaic_Manifest_v1`. \
         {FREEZE_HINT}"
    );
    assert_eq!(
        MANIFEST_SIGN_CONTEXT.len(),
        18,
        "MANIFEST_SIGN_CONTEXT must be exactly 18 bytes. {FREEZE_HINT}"
    );
    // Byte-by-byte verification so a UTF-8 visually identical homoglyph swap
    // (e.g. Cyrillic `а`) cannot pass.
    assert_eq!(
        MANIFEST_SIGN_CONTEXT,
        [
            0x4d, 0x6f, 0x73, 0x61, 0x69, 0x63, 0x5f, 0x4d, 0x61, 0x6e, 0x69, 0x66, 0x65, 0x73,
            0x74, 0x5f, 0x76, 0x31,
        ]
        .as_slice(),
        "MANIFEST_SIGN_CONTEXT byte values must match ASCII `Mosaic_Manifest_v1`. \
         {FREEZE_HINT}"
    );
    assert_eq!(
        MANIFEST_TRANSCRIPT_VERSION, 1_u8,
        "MANIFEST_TRANSCRIPT_VERSION must remain 1 at the late-v1 freeze. \
         {FREEZE_HINT}"
    );
}

#[test]
fn metadata_sidecar_context_is_frozen_at_mosaic_metadata_v1() {
    assert_eq!(
        METADATA_SIDECAR_CONTEXT,
        b"Mosaic_Metadata_v1".as_slice(),
        "METADATA_SIDECAR_CONTEXT must equal the UTF-8 bytes `Mosaic_Metadata_v1`. \
         {FREEZE_HINT}"
    );
    assert_eq!(
        METADATA_SIDECAR_CONTEXT.len(),
        18,
        "METADATA_SIDECAR_CONTEXT must be exactly 18 bytes. {FREEZE_HINT}"
    );
    assert_eq!(
        METADATA_SIDECAR_CONTEXT,
        [
            0x4d, 0x6f, 0x73, 0x61, 0x69, 0x63, 0x5f, 0x4d, 0x65, 0x74, 0x61, 0x64, 0x61, 0x74,
            0x61, 0x5f, 0x76, 0x31,
        ]
        .as_slice(),
        "METADATA_SIDECAR_CONTEXT byte values must match ASCII `Mosaic_Metadata_v1`. \
         {FREEZE_HINT}"
    );
    assert_eq!(
        METADATA_SIDECAR_VERSION, 1_u8,
        "METADATA_SIDECAR_VERSION must remain 1 at the late-v1 freeze. \
         {FREEZE_HINT}"
    );
}

#[test]
fn manifest_and_metadata_contexts_are_distinct_domains() {
    // Domain separation between manifest signing transcripts and metadata
    // sidecar canonical bytes is part of the frozen contract: a future change
    // that accidentally aliased one to the other would break cross-client
    // verification. Lock the inequality so the freeze is enforced at the
    // domain-separation level, not just at the bytewise level.
    assert_ne!(
        MANIFEST_SIGN_CONTEXT, METADATA_SIDECAR_CONTEXT,
        "Manifest and metadata domain-separation contexts must differ. \
         {FREEZE_HINT}"
    );
}
