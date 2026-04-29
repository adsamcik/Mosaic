//! Targeted kill tests for `cargo-mutants` mutants that are not exercised
//! tightly by the main `tests/*.rs` suites.
//!
//! Each test here is anchored to specific source line numbers in
//! `crates/mosaic-domain/src/lib.rs` and asserts byte-exact / capacity-exact /
//! offset-exact properties so a single-character mutation observably changes
//! the result. Tests follow the project's idiom established in
//! `crates/mosaic-crypto/tests/mutation_kills.rs`.
//!
//! Mutants intentionally NOT killed here:
//!
//! * `replace <impl TryFrom<u8> for ShardTier>::try_from -> Result<Self,
//!   Self::Error> with Ok(Default::default())` and the various `Vec::leak` /
//!   `Box::leak` accessor replacements at lines 158, 195, 201, 207, 213, 237,
//!   276, 282, 288, 326, 338, 344. These are reported `unviable` by
//!   `cargo-mutants` because they do not satisfy the function's lifetime or
//!   return-type contract and therefore never compile, so they cannot survive
//!   any test.

#![forbid(unsafe_code)]
#![allow(clippy::identity_op)]

use mosaic_domain::{
    EncryptedMetadataEnvelope, MANIFEST_SIGN_CONTEXT, MANIFEST_TRANSCRIPT_VERSION,
    METADATA_SIDECAR_CONTEXT, METADATA_SIDECAR_VERSION, ManifestShardRef, ManifestTranscript,
    ManifestTranscriptError, MetadataSidecar, MetadataSidecarError, MetadataSidecarField,
    MosaicDomainError, PROTOCOL_VERSION, SHARD_ENVELOPE_HEADER_LEN, SHARD_ENVELOPE_MAGIC,
    SHARD_ENVELOPE_VERSION, ShardEnvelopeHeader, ShardTier, canonical_manifest_transcript_bytes,
    canonical_metadata_sidecar_bytes, crate_name, golden_vectors, metadata_field_tags,
};

const NONCE: [u8; 24] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
];

const ALBUM_ID: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];

const PHOTO_ID: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];

fn shard_ref(
    chunk_index: u32,
    tier: ShardTier,
    first_id_byte: u8,
    hash_byte: u8,
) -> ManifestShardRef {
    let mut shard_id = [0_u8; 16];
    for (offset, byte) in shard_id.iter_mut().enumerate() {
        *byte = first_id_byte.wrapping_add(offset as u8);
    }
    ManifestShardRef::new(chunk_index, shard_id, tier, [hash_byte; 32])
}

#[test]
fn protocol_version_and_crate_name_are_byte_exact() {
    assert_eq!(PROTOCOL_VERSION, "mosaic-v1");
    assert_eq!(PROTOCOL_VERSION.len(), 9);
    assert_eq!(PROTOCOL_VERSION.as_bytes(), b"mosaic-v1");

    assert_eq!(crate_name(), "mosaic-domain");
    assert_eq!(crate_name().len(), 13);
    assert_eq!(crate_name().as_bytes(), b"mosaic-domain");
}

#[test]
fn shard_envelope_constants_are_byte_exact() {
    assert_eq!(SHARD_ENVELOPE_MAGIC, *b"SGzk");
    assert_eq!(SHARD_ENVELOPE_MAGIC.len(), 4);
    assert_eq!(SHARD_ENVELOPE_VERSION, 0x03);
    assert_eq!(SHARD_ENVELOPE_HEADER_LEN, 64);
}

#[test]
fn transcript_and_sidecar_context_constants_are_byte_exact() {
    assert_eq!(MANIFEST_SIGN_CONTEXT, b"Mosaic_Manifest_v1");
    assert_eq!(MANIFEST_SIGN_CONTEXT.len(), 18);
    assert_eq!(MANIFEST_TRANSCRIPT_VERSION, 1);

    assert_eq!(METADATA_SIDECAR_CONTEXT, b"Mosaic_Metadata_v1");
    assert_eq!(METADATA_SIDECAR_CONTEXT.len(), 18);
    assert_eq!(METADATA_SIDECAR_VERSION, 1);
}

#[test]
fn metadata_field_tags_have_fixed_protocol_values() {
    assert_eq!(metadata_field_tags::ORIENTATION, 1);
    assert_eq!(metadata_field_tags::DEVICE_TIMESTAMP_MS, 2);
    assert_eq!(metadata_field_tags::ORIGINAL_DIMENSIONS, 3);
    assert_eq!(metadata_field_tags::MIME_OVERRIDE, 4);
    assert_eq!(metadata_field_tags::CAPTION, 5);
    assert_eq!(metadata_field_tags::FILENAME, 6);
    assert_eq!(metadata_field_tags::CAMERA_MAKE, 7);
    assert_eq!(metadata_field_tags::CAMERA_MODEL, 8);
    assert_eq!(metadata_field_tags::GPS, 9);
}

#[test]
fn shard_tier_to_byte_round_trips_each_protocol_value() {
    for &(value, tier) in &[
        (1_u8, ShardTier::Thumbnail),
        (2_u8, ShardTier::Preview),
        (3_u8, ShardTier::Original),
    ] {
        assert_eq!(tier.to_byte(), value);
        assert_eq!(ShardTier::try_from(value), Ok(tier));
        assert_eq!(ShardTier::try_from(tier.to_byte()), Ok(tier));
    }

    assert_ne!(ShardTier::Thumbnail.to_byte(), ShardTier::Preview.to_byte());
    assert_ne!(ShardTier::Preview.to_byte(), ShardTier::Original.to_byte());
    assert_ne!(
        ShardTier::Thumbnail.to_byte(),
        ShardTier::Original.to_byte()
    );
}

#[test]
fn canonical_metadata_sidecar_bytes_match_fixed_layout_for_empty_fields() {
    let sidecar = MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 7, &[]);
    let bytes = match canonical_metadata_sidecar_bytes(&sidecar) {
        Ok(value) => value,
        Err(error) => panic!("empty sidecar should serialize: {error:?}"),
    };

    let mut expected = Vec::new();
    expected.extend_from_slice(METADATA_SIDECAR_CONTEXT);
    expected.push(METADATA_SIDECAR_VERSION);
    expected.extend_from_slice(&ALBUM_ID);
    expected.extend_from_slice(&PHOTO_ID);
    expected.extend_from_slice(&7_u32.to_le_bytes());
    expected.extend_from_slice(&0_u32.to_le_bytes());

    assert_eq!(bytes.len(), expected.len());
    assert_eq!(bytes.len(), 18 + 1 + 16 + 16 + 4 + 4);
    assert_eq!(bytes, expected);
}

#[test]
fn canonical_metadata_sidecar_bytes_serialize_two_fields_in_tag_order() {
    let orientation = 1_u16.to_le_bytes();
    let dimensions = {
        let mut bytes = [0_u8; 8];
        bytes[..4].copy_from_slice(&64_u32.to_le_bytes());
        bytes[4..].copy_from_slice(&64_u32.to_le_bytes());
        bytes
    };
    let fields = [
        MetadataSidecarField::new(metadata_field_tags::ORIENTATION, &orientation),
        MetadataSidecarField::new(metadata_field_tags::ORIGINAL_DIMENSIONS, &dimensions),
    ];
    let sidecar = MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 7, &fields);

    let bytes = match canonical_metadata_sidecar_bytes(&sidecar) {
        Ok(value) => value,
        Err(error) => panic!("sidecar should serialize: {error:?}"),
    };

    assert_eq!(&bytes[..18], METADATA_SIDECAR_CONTEXT);
    assert_eq!(bytes[18], METADATA_SIDECAR_VERSION);
    assert_eq!(&bytes[19..35], &ALBUM_ID);
    assert_eq!(&bytes[35..51], &PHOTO_ID);
    assert_eq!(&bytes[51..55], &7_u32.to_le_bytes());
    assert_eq!(&bytes[55..59], &2_u32.to_le_bytes());

    assert_eq!(&bytes[59..61], &1_u16.to_le_bytes());
    assert_eq!(&bytes[61..65], &2_u32.to_le_bytes());
    assert_eq!(&bytes[65..67], &orientation);

    assert_eq!(&bytes[67..69], &3_u16.to_le_bytes());
    assert_eq!(&bytes[69..73], &8_u32.to_le_bytes());
    assert_eq!(&bytes[73..81], &dimensions);

    assert_eq!(bytes.len(), 59 + 6 + 2 + 6 + 8);
}

#[test]
fn canonical_metadata_sidecar_bytes_distinguishes_duplicate_and_unsorted_tags() {
    let value = [0xaa, 0xbb];
    let duplicate = [
        MetadataSidecarField::new(2, &value),
        MetadataSidecarField::new(2, &value),
    ];
    let unsorted = [
        MetadataSidecarField::new(5, &value),
        MetadataSidecarField::new(3, &value),
    ];

    let duplicate_error = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 0, &duplicate,
    )) {
        Ok(_) => panic!("duplicate tags should fail"),
        Err(error) => error,
    };
    assert_eq!(
        duplicate_error,
        MetadataSidecarError::DuplicateFieldTag { tag: 2 }
    );

    let unsorted_error = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 0, &unsorted,
    )) {
        Ok(_) => panic!("unsorted tags should fail"),
        Err(error) => error,
    };
    assert_eq!(
        unsorted_error,
        MetadataSidecarError::UnsortedFieldTag {
            previous: 5,
            actual: 3
        }
    );
}

#[test]
fn canonical_metadata_sidecar_bytes_rejects_zero_tag_and_empty_value() {
    let value = [0xcc];
    let zero_tag = [MetadataSidecarField::new(0, &value)];
    let empty_value = [MetadataSidecarField::new(2, b"")];

    assert_eq!(
        canonical_metadata_sidecar_bytes(&MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 0, &zero_tag)),
        Err(MetadataSidecarError::ZeroFieldTag)
    );
    assert_eq!(
        canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
            ALBUM_ID,
            PHOTO_ID,
            0,
            &empty_value
        )),
        Err(MetadataSidecarError::EmptyFieldValue { tag: 2 })
    );
}

#[test]
fn canonical_manifest_transcript_bytes_match_fixed_layout_for_single_shard() {
    let encrypted_meta = [0xaa, 0xbb, 0xcc];
    let shards = [shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11)];
    let transcript = ManifestTranscript::new(
        ALBUM_ID,
        7,
        EncryptedMetadataEnvelope::new(&encrypted_meta),
        &shards,
    );

    let bytes = match canonical_manifest_transcript_bytes(&transcript) {
        Ok(value) => value,
        Err(error) => panic!("transcript should serialize: {error:?}"),
    };

    let mut expected = Vec::new();
    expected.extend_from_slice(MANIFEST_SIGN_CONTEXT);
    expected.push(MANIFEST_TRANSCRIPT_VERSION);
    expected.extend_from_slice(&ALBUM_ID);
    expected.extend_from_slice(&7_u32.to_le_bytes());
    expected.extend_from_slice(&3_u32.to_le_bytes());
    expected.extend_from_slice(&encrypted_meta);
    expected.extend_from_slice(&1_u32.to_le_bytes());
    expected.extend_from_slice(&0_u32.to_le_bytes());
    expected.push(ShardTier::Thumbnail.to_byte());
    let mut shard_id = [0_u8; 16];
    for (offset, byte) in shard_id.iter_mut().enumerate() {
        *byte = 0x10_u8.wrapping_add(offset as u8);
    }
    expected.extend_from_slice(&shard_id);
    expected.extend_from_slice(&[0x11; 32]);

    assert_eq!(bytes.len(), expected.len());
    assert_eq!(bytes.len(), 18 + 1 + 16 + 4 + 4 + 3 + 4 + 4 + 1 + 16 + 32);
    assert_eq!(bytes, expected);

    assert!(bytes.len() > 1);
    assert_ne!(bytes, vec![0_u8]);
    assert_ne!(bytes, Vec::<u8>::new());
}

#[test]
fn canonical_manifest_transcript_bytes_sort_then_validate_yields_canonical_form() {
    let encrypted_meta = [0x99, 0x88];
    let ordered_shards = [
        shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11),
        shard_ref(1, ShardTier::Preview, 0x20, 0x22),
    ];
    let reversed_shards = [ordered_shards[1], ordered_shards[0]];

    let ordered = canonical_manifest_transcript_bytes(&ManifestTranscript::new(
        ALBUM_ID,
        3,
        EncryptedMetadataEnvelope::new(&encrypted_meta),
        &ordered_shards,
    ));
    let reversed = canonical_manifest_transcript_bytes(&ManifestTranscript::new(
        ALBUM_ID,
        3,
        EncryptedMetadataEnvelope::new(&encrypted_meta),
        &reversed_shards,
    ));
    let ordered_bytes = match ordered {
        Ok(value) => value,
        Err(error) => panic!("ordered transcript should serialize: {error:?}"),
    };
    let reversed_bytes = match reversed {
        Ok(value) => value,
        Err(error) => panic!("reversed transcript should serialize canonically: {error:?}"),
    };

    assert_eq!(ordered_bytes, reversed_bytes);
}

#[test]
fn canonical_manifest_transcript_bytes_rejects_empty_inputs() {
    let any_shard = [shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11)];

    assert_eq!(
        canonical_manifest_transcript_bytes(&ManifestTranscript::new(
            ALBUM_ID,
            1,
            EncryptedMetadataEnvelope::new(&[]),
            &any_shard,
        )),
        Err(ManifestTranscriptError::EmptyEncryptedMeta)
    );

    let some_meta = [0xaa];
    assert_eq!(
        canonical_manifest_transcript_bytes(&ManifestTranscript::new(
            ALBUM_ID,
            1,
            EncryptedMetadataEnvelope::new(&some_meta),
            &[],
        )),
        Err(ManifestTranscriptError::EmptyShardList)
    );
}

#[test]
fn canonical_manifest_transcript_bytes_reports_first_non_sequential_index() {
    let encrypted_meta = [0xaa];
    let gap_shards = [
        shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11),
        shard_ref(2, ShardTier::Preview, 0x20, 0x22),
    ];

    assert_eq!(
        canonical_manifest_transcript_bytes(&ManifestTranscript::new(
            ALBUM_ID,
            1,
            EncryptedMetadataEnvelope::new(&encrypted_meta),
            &gap_shards,
        )),
        Err(ManifestTranscriptError::NonSequentialShardIndex {
            expected: 1,
            actual: 2
        })
    );

    let duplicate_shards = [
        shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11),
        shard_ref(0, ShardTier::Preview, 0x20, 0x22),
    ];
    assert_eq!(
        canonical_manifest_transcript_bytes(&ManifestTranscript::new(
            ALBUM_ID,
            1,
            EncryptedMetadataEnvelope::new(&encrypted_meta),
            &duplicate_shards,
        )),
        Err(ManifestTranscriptError::NonSequentialShardIndex {
            expected: 1,
            actual: 0
        })
    );
}

#[test]
fn shard_envelope_parse_reports_first_non_zero_reserved_offset_at_relative_one() {
    let mut bytes = ShardEnvelopeHeader::new(42, 7, NONCE, ShardTier::Thumbnail).to_bytes();
    bytes[39] = 0xff;

    let error = match ShardEnvelopeHeader::parse(&bytes) {
        Ok(value) => panic!("non-zero reserved byte should fail: {value:?}"),
        Err(error) => error,
    };

    assert_eq!(error, MosaicDomainError::NonZeroReservedByte { offset: 39 });
    assert_ne!(error, MosaicDomainError::NonZeroReservedByte { offset: 37 });
    assert_ne!(error, MosaicDomainError::NonZeroReservedByte { offset: 38 });
}

#[test]
fn shard_envelope_parse_reports_first_non_zero_reserved_offset_at_relative_two() {
    let mut bytes = ShardEnvelopeHeader::new(42, 7, NONCE, ShardTier::Thumbnail).to_bytes();
    bytes[40] = 0x01;

    assert_eq!(
        ShardEnvelopeHeader::parse(&bytes),
        Err(MosaicDomainError::NonZeroReservedByte { offset: 40 })
    );
}

#[test]
fn shard_envelope_parse_visits_every_reserved_offset_inclusive() {
    let header = ShardEnvelopeHeader::new(42, 7, NONCE, ShardTier::Thumbnail);
    let baseline = header.to_bytes();

    for offset in 38..SHARD_ENVELOPE_HEADER_LEN {
        let mut bytes = baseline;
        bytes[offset] = 1;
        assert_eq!(
            ShardEnvelopeHeader::parse(&bytes),
            Err(MosaicDomainError::NonZeroReservedByte { offset })
        );
    }

    let mut bytes = baseline;
    bytes[63] = 0xff;
    assert_eq!(
        ShardEnvelopeHeader::parse(&bytes),
        Err(MosaicDomainError::NonZeroReservedByte { offset: 63 })
    );
}

#[test]
fn shard_envelope_parse_rejects_each_failure_mode_with_distinct_error() {
    let valid = ShardEnvelopeHeader::new(42, 7, NONCE, ShardTier::Original).to_bytes();

    assert_eq!(
        ShardEnvelopeHeader::parse(&valid[..SHARD_ENVELOPE_HEADER_LEN - 1]),
        Err(MosaicDomainError::InvalidHeaderLength {
            actual: SHARD_ENVELOPE_HEADER_LEN - 1
        })
    );
    let mut too_long = valid.to_vec();
    too_long.push(0);
    assert_eq!(
        ShardEnvelopeHeader::parse(&too_long),
        Err(MosaicDomainError::InvalidHeaderLength {
            actual: SHARD_ENVELOPE_HEADER_LEN + 1
        })
    );

    let mut bad_magic = valid;
    bad_magic[0] = b'X';
    assert_eq!(
        ShardEnvelopeHeader::parse(&bad_magic),
        Err(MosaicDomainError::InvalidMagic)
    );

    let mut bad_version = valid;
    bad_version[4] = 0x99;
    assert_eq!(
        ShardEnvelopeHeader::parse(&bad_version),
        Err(MosaicDomainError::UnsupportedVersion { version: 0x99 })
    );

    let mut bad_tier = valid;
    bad_tier[37] = 0xfe;
    assert_eq!(
        ShardEnvelopeHeader::parse(&bad_tier),
        Err(MosaicDomainError::InvalidTier { value: 0xfe })
    );
}

#[test]
fn shard_envelope_to_bytes_places_each_field_at_protocol_offset() {
    let header = ShardEnvelopeHeader::new(0x0102_0304, 0x0506_0708, NONCE, ShardTier::Preview);
    let bytes = header.to_bytes();

    assert_eq!(bytes.len(), SHARD_ENVELOPE_HEADER_LEN);
    assert_eq!(&bytes[0..4], &SHARD_ENVELOPE_MAGIC);
    assert_eq!(bytes[4], SHARD_ENVELOPE_VERSION);
    assert_eq!(&bytes[5..9], &0x0102_0304_u32.to_le_bytes());
    assert_eq!(&bytes[9..13], &0x0506_0708_u32.to_le_bytes());
    assert_eq!(&bytes[13..37], &NONCE);
    assert_eq!(bytes[37], ShardTier::Preview.to_byte());
    for byte in &bytes[38..64] {
        assert_eq!(*byte, 0);
    }
}

#[test]
fn shard_envelope_accessors_return_constructor_inputs() {
    let header = ShardEnvelopeHeader::new(0xabcd_ef01, 0x1234_5678, NONCE, ShardTier::Original);

    assert_eq!(header.epoch_id(), 0xabcd_ef01);
    assert_eq!(header.shard_index(), 0x1234_5678);
    assert_eq!(header.nonce(), &NONCE);
    assert_eq!(header.tier(), ShardTier::Original);
}

#[test]
fn golden_envelope_header_bytes_have_fixed_protocol_layout() {
    let bytes = golden_vectors::envelope_header_bytes();

    assert_eq!(bytes.len(), SHARD_ENVELOPE_HEADER_LEN);
    assert_eq!(&bytes[0..4], &SHARD_ENVELOPE_MAGIC);
    assert_eq!(bytes[4], SHARD_ENVELOPE_VERSION);
    assert_eq!(
        &bytes[5..9],
        &golden_vectors::ENVELOPE_EPOCH_ID.to_le_bytes()
    );
    assert_eq!(
        &bytes[9..13],
        &golden_vectors::ENVELOPE_SHARD_INDEX.to_le_bytes()
    );
    assert_eq!(&bytes[13..37], &golden_vectors::ENVELOPE_NONCE);
    assert_eq!(bytes[37], ShardTier::Preview.to_byte());
    for byte in &bytes[38..64] {
        assert_eq!(*byte, 0);
    }
}

#[test]
fn golden_manifest_transcript_bytes_have_fixed_canonical_layout() {
    let bytes = match golden_vectors::manifest_transcript_bytes() {
        Ok(value) => value,
        Err(error) => panic!("golden manifest transcript should serialize: {error:?}"),
    };

    assert!(
        bytes.len() > 1 + MANIFEST_SIGN_CONTEXT.len(),
        "golden transcript should not collapse to a sentinel value"
    );
    assert_eq!(&bytes[..MANIFEST_SIGN_CONTEXT.len()], MANIFEST_SIGN_CONTEXT);
    assert_eq!(
        bytes[MANIFEST_SIGN_CONTEXT.len()],
        MANIFEST_TRANSCRIPT_VERSION
    );
}

#[test]
fn manifest_shard_ref_accessors_return_their_own_field() {
    let shard_id = [0xa0_u8; 16];
    let sha = [0xb1_u8; 32];
    let shard = ManifestShardRef::new(0xcafe_d00d, shard_id, ShardTier::Preview, sha);

    assert_eq!(shard.chunk_index(), 0xcafe_d00d);
    assert_eq!(shard.shard_id(), &shard_id);
    assert_eq!(shard.tier(), ShardTier::Preview);
    assert_eq!(shard.sha256(), &sha);
}

#[test]
fn manifest_transcript_accessors_return_their_own_field() {
    let encrypted_meta = [0x77, 0x88, 0x99];
    let shards = [shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11)];
    let transcript = ManifestTranscript::new(
        ALBUM_ID,
        0xdead_beef,
        EncryptedMetadataEnvelope::new(&encrypted_meta),
        &shards,
    );

    assert_eq!(transcript.album_id(), &ALBUM_ID);
    assert_eq!(transcript.epoch_id(), 0xdead_beef);
    assert_eq!(transcript.encrypted_meta(), &encrypted_meta);
    assert_eq!(transcript.shards().len(), 1);
    assert_eq!(transcript.shards()[0].chunk_index(), 0);
}

#[test]
fn metadata_sidecar_and_field_accessors_return_their_own_field() {
    let value = [0xab, 0xcd];
    let field = MetadataSidecarField::new(7, &value);
    assert_eq!(field.tag(), 7);
    assert_eq!(field.value(), &value);

    let fields = [field];
    let sidecar = MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 0xfeed_face, &fields);
    assert_eq!(sidecar.album_id(), &ALBUM_ID);
    assert_eq!(sidecar.photo_id(), &PHOTO_ID);
    assert_eq!(sidecar.epoch_id(), 0xfeed_face);
    assert_eq!(sidecar.fields().len(), 1);
    assert_eq!(sidecar.fields()[0].tag(), 7);
}

#[test]
fn encrypted_metadata_envelope_bytes_returns_input_verbatim() {
    let payload = [0xde, 0xad, 0xbe, 0xef];
    let envelope = EncryptedMetadataEnvelope::new(&payload);
    assert_eq!(envelope.bytes(), &payload);
    assert_eq!(envelope.bytes().len(), 4);
}
