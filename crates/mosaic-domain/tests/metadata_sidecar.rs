use mosaic_domain::{
    EncryptedMetadataEnvelope, MAX_SIDECAR_TOTAL_BYTES, ManifestShardRef, ManifestTranscript,
    MetadataSidecar, MetadataSidecarError, MetadataSidecarField, ShardTier, SidecarTagStatus,
    canonical_manifest_transcript_bytes, canonical_metadata_sidecar_bytes, metadata_field_tags,
};

const ALBUM_ID: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const PHOTO_ID: [u8; 16] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
const FIXED_METADATA_SIDECAR_HEADER_BYTES: usize = 59;
const TLV_RECORD_HEADER_BYTES: usize = 2 + 4;

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn shard_ref() -> ManifestShardRef {
    let mut shard_id = [0_u8; 16];
    for (offset, byte) in shard_id.iter_mut().enumerate() {
        *byte = 0x40 + offset as u8;
    }

    ManifestShardRef::new(0, shard_id, ShardTier::Original, [0x55; 32])
}

fn contains_subsequence(bytes: &[u8], needle: &[u8]) -> bool {
    bytes.windows(needle.len()).any(|window| window == needle)
}

#[test]
fn metadata_sidecar_serializes_to_fixed_canonical_golden_bytes() {
    let orientation = [0x06, 0x00];
    let dimensions = {
        let mut bytes = [0_u8; 8];
        bytes[..4].copy_from_slice(&4032_u32.to_le_bytes());
        bytes[4..].copy_from_slice(&3024_u32.to_le_bytes());
        bytes
    };
    let mime = b"image/jpeg";
    let fields = [
        MetadataSidecarField::new(metadata_field_tags::ORIENTATION, &orientation),
        MetadataSidecarField::new(metadata_field_tags::ORIGINAL_DIMENSIONS, &dimensions),
        MetadataSidecarField::new(metadata_field_tags::MIME_OVERRIDE, mime),
    ];
    let sidecar = MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 0x0102_0304, &fields);

    let bytes = match canonical_metadata_sidecar_bytes(&sidecar) {
        Ok(value) => value,
        Err(error) => panic!("metadata sidecar should serialize: {error:?}"),
    };

    assert_eq!(bytes.len(), 97);
    assert_eq!(
        hex(&bytes),
        "4d6f736169635f4d657461646174615f763101000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f04030201030000000100020000000600020008000000c00f0000d00b000004000a000000696d6167652f6a706567"
    );
}

#[test]
fn mime_override_preserves_non_nfc_bytes_exactly() {
    let decomposed_mime = "image/x-mosaic-e\u{301}".as_bytes();
    let fields = [MetadataSidecarField::new(
        metadata_field_tags::MIME_OVERRIDE,
        decomposed_mime,
    )];
    let bytes = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID,
        PHOTO_ID,
        0x0102_0304,
        &fields,
    )) {
        Ok(value) => value,
        Err(error) => panic!("non-NFC MIME override bytes should serialize: {error:?}"),
    };

    let value_start = 59 + 2 + 4;
    assert_eq!(
        &bytes[value_start..value_start + decomposed_mime.len()],
        decomposed_mime
    );
    assert!(!contains_subsequence(&bytes, "image/x-mosaic-é".as_bytes()));
}

#[test]
fn metadata_sidecar_accepts_empty_field_list_as_canonical_empty_payload() {
    let sidecar = MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 7, &[]);

    let bytes = match canonical_metadata_sidecar_bytes(&sidecar) {
        Ok(value) => value,
        Err(error) => panic!("empty metadata sidecar should serialize: {error:?}"),
    };

    assert_eq!(bytes.len(), 59);
    assert_eq!(
        hex(&bytes),
        "4d6f736169635f4d657461646174615f763101000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f0700000000000000"
    );
}

#[test]
fn metadata_sidecar_rejects_unsorted_and_duplicate_tags() {
    let orientation = [0x06, 0x00];
    let mime = b"image/jpeg";
    let unsorted = [
        MetadataSidecarField::new(metadata_field_tags::MIME_OVERRIDE, mime),
        MetadataSidecarField::new(metadata_field_tags::ORIENTATION, &orientation),
    ];
    let duplicate = [
        MetadataSidecarField::new(metadata_field_tags::ORIENTATION, &orientation),
        MetadataSidecarField::new(metadata_field_tags::ORIENTATION, &orientation),
    ];

    let unsorted_error = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &unsorted,
    )) {
        Ok(_) => panic!("unsorted tags should fail"),
        Err(error) => error,
    };
    assert_eq!(
        unsorted_error,
        MetadataSidecarError::UnsortedFieldTag {
            previous: metadata_field_tags::MIME_OVERRIDE,
            actual: metadata_field_tags::ORIENTATION
        }
    );

    let duplicate_error = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &duplicate,
    )) {
        Ok(_) => panic!("duplicate tags should fail"),
        Err(error) => error,
    };
    assert_eq!(
        duplicate_error,
        MetadataSidecarError::DuplicateFieldTag {
            tag: metadata_field_tags::ORIENTATION
        }
    );
}

#[test]
fn metadata_sidecar_rejects_zero_tags_and_empty_field_values() {
    let value = [0x01];
    let zero_tag = [MetadataSidecarField::new(0, &value)];
    let empty_value = [MetadataSidecarField::new(
        metadata_field_tags::ORIENTATION,
        &[],
    )];

    let zero_tag_error = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &zero_tag,
    )) {
        Ok(_) => panic!("zero tag should fail"),
        Err(error) => error,
    };
    assert_eq!(zero_tag_error, MetadataSidecarError::ZeroFieldTag);

    let empty_value_error = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID,
        PHOTO_ID,
        1,
        &empty_value,
    )) {
        Ok(_) => panic!("empty field value should fail"),
        Err(error) => error,
    };
    assert_eq!(
        empty_value_error,
        MetadataSidecarError::EmptyFieldValue {
            tag: metadata_field_tags::ORIENTATION
        }
    );
}

#[test]
fn manifest_transcript_binds_encrypted_opaque_sidecar_envelope_bytes_not_plaintext_sidecar() {
    let orientation = [0x06, 0x00];
    let fields = [MetadataSidecarField::new(
        metadata_field_tags::ORIENTATION,
        &orientation,
    )];
    let plaintext_canonical_sidecar = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 9, &fields,
    )) {
        Ok(value) => value,
        Err(error) => panic!("plaintext sidecar should serialize locally: {error:?}"),
    };
    let encrypted_sidecar_envelope = [
        0xc7, 0x9e, 0x00, 0xfe, 0x51, 0x17, 0xa4, 0x3c, 0x88, 0x01, 0x62, 0xdb,
    ];
    let shards = [shard_ref()];
    let transcript = ManifestTranscript::new(
        ALBUM_ID,
        9,
        EncryptedMetadataEnvelope::new(&encrypted_sidecar_envelope),
        &shards,
    );

    let transcript_bytes = match canonical_manifest_transcript_bytes(&transcript) {
        Ok(value) => value,
        Err(error) => panic!("manifest transcript should serialize: {error:?}"),
    };

    assert_eq!(transcript.encrypted_meta(), encrypted_sidecar_envelope);
    assert!(contains_subsequence(
        &transcript_bytes,
        &encrypted_sidecar_envelope
    ));
    assert!(!contains_subsequence(
        &transcript_bytes,
        &plaintext_canonical_sidecar
    ));
}

#[test]
fn encoder_rejects_filename_tag_6_reserved() {
    let fields = [MetadataSidecarField::new(6, b"img.jpg")];
    assert_eq!(
        canonical_metadata_sidecar_bytes(&MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 1, &fields)),
        Err(MetadataSidecarError::ForbiddenTag { tag: 6 })
    );
}

#[test]
fn encoder_rejects_empty_reserved_tag_before_empty_value() {
    let fields = [MetadataSidecarField::new(6, b"")];
    assert_eq!(
        canonical_metadata_sidecar_bytes(&MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 1, &fields)),
        Err(MetadataSidecarError::ForbiddenTag { tag: 6 })
    );
}

#[test]
fn encoder_rejects_sidecar_total_bytes_above_cap() {
    let oversized_value = vec![0x61; MAX_SIDECAR_TOTAL_BYTES];
    let fields = [MetadataSidecarField::new(
        metadata_field_tags::MIME_OVERRIDE,
        &oversized_value,
    )];

    let error = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &fields,
    )) {
        Ok(_) => panic!("sidecar above total cap should fail"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        MetadataSidecarError::LengthTooLarge {
            field: "sidecar_total_bytes",
            actual: FIXED_METADATA_SIDECAR_HEADER_BYTES
                + TLV_RECORD_HEADER_BYTES
                + MAX_SIDECAR_TOTAL_BYTES
        }
    );
}

#[test]
fn encoder_accepts_sidecar_at_exact_cap_boundary() {
    let largest_legal_value_len =
        MAX_SIDECAR_TOTAL_BYTES - FIXED_METADATA_SIDECAR_HEADER_BYTES - TLV_RECORD_HEADER_BYTES;
    assert_eq!(largest_legal_value_len, 65_471);
    let boundary_value = vec![0x61; largest_legal_value_len];
    let fields = [MetadataSidecarField::new(
        metadata_field_tags::MIME_OVERRIDE,
        &boundary_value,
    )];

    let bytes = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &fields,
    )) {
        Ok(bytes) => bytes,
        Err(error) => panic!("sidecar at exact total cap should serialize: {error:?}"),
    };

    assert_eq!(bytes.len(), MAX_SIDECAR_TOTAL_BYTES);
}

#[test]
fn encoder_rejects_sidecar_one_byte_over_cap() {
    let one_byte_too_large_value_len =
        MAX_SIDECAR_TOTAL_BYTES - FIXED_METADATA_SIDECAR_HEADER_BYTES - TLV_RECORD_HEADER_BYTES + 1;
    assert_eq!(one_byte_too_large_value_len, 65_472);
    let over_boundary_value = vec![0x61; one_byte_too_large_value_len];
    let fields = [MetadataSidecarField::new(
        metadata_field_tags::MIME_OVERRIDE,
        &over_boundary_value,
    )];

    let error = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &fields,
    )) {
        Ok(_) => panic!("sidecar one byte above total cap should fail"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        MetadataSidecarError::LengthTooLarge {
            field: "sidecar_total_bytes",
            actual: MAX_SIDECAR_TOTAL_BYTES + 1
        }
    );
}

#[test]
fn worst_case_active_tag_sidecar_fits_within_cap() {
    let active_tags: Vec<_> = metadata_field_tags::KNOWN_FIELD_TAGS
        .iter()
        .filter(|entry| entry.status() == SidecarTagStatus::Active)
        .map(|entry| entry.tag_number())
        .collect();
    assert_eq!(
        active_tags,
        vec![
            metadata_field_tags::ORIENTATION,
            metadata_field_tags::ORIGINAL_DIMENSIONS,
            metadata_field_tags::DEVICE_TIMESTAMP_MS,
            metadata_field_tags::MIME_OVERRIDE,
            metadata_field_tags::CAMERA_MAKE,
            metadata_field_tags::CAMERA_MODEL,
            metadata_field_tags::SUBSECONDS_MS,
            metadata_field_tags::GPS,
            metadata_field_tags::CODEC_FOURCC,
            metadata_field_tags::DURATION_MS,
            metadata_field_tags::FRAME_RATE_X100,
            metadata_field_tags::VIDEO_ORIENTATION,
            metadata_field_tags::VIDEO_DIMENSIONS,
            metadata_field_tags::VIDEO_CONTAINER_FORMAT,
        ],
        "new Active tags must re-evaluate MAX_SIDECAR_TOTAL_BYTES"
    );

    let orientation = 8_u16.to_le_bytes();
    let dimensions = {
        let mut bytes = [0_u8; 8];
        bytes[..4].copy_from_slice(&u32::MAX.to_le_bytes());
        bytes[4..].copy_from_slice(&u32::MAX.to_le_bytes());
        bytes
    };
    let mime_override = b"image/jpeg";
    let timestamp = u64::MAX.to_le_bytes();
    let camera_make = [b'M'; 64];
    let camera_model = [b'Z'; 64];
    let subseconds = 999_u32.to_le_bytes();
    let mut gps = [0_u8; 14];
    gps[..4].copy_from_slice(&90_000_000_i32.to_le_bytes());
    gps[4..8].copy_from_slice(&180_000_000_i32.to_le_bytes());
    gps[8..12].copy_from_slice(&i32::MAX.to_le_bytes());
    gps[12..14].copy_from_slice(&u16::MAX.to_le_bytes());
    let codec = [u8::MAX];
    let video_duration = u64::MAX.to_le_bytes();
    let frame_rate = u32::MAX.to_le_bytes();
    let video_orientation = [u8::MAX];
    let mut video_dimensions = [0_u8; 8];
    video_dimensions[..4].copy_from_slice(&u32::MAX.to_le_bytes());
    video_dimensions[4..].copy_from_slice(&u32::MAX.to_le_bytes());
    let video_container = [u8::MAX];
    let fields = [
        MetadataSidecarField::new(metadata_field_tags::ORIENTATION, &orientation),
        MetadataSidecarField::new(metadata_field_tags::ORIGINAL_DIMENSIONS, &dimensions),
        MetadataSidecarField::new(metadata_field_tags::DEVICE_TIMESTAMP_MS, &timestamp),
        MetadataSidecarField::new(metadata_field_tags::MIME_OVERRIDE, mime_override),
        MetadataSidecarField::new(metadata_field_tags::CAMERA_MAKE, &camera_make),
        MetadataSidecarField::new(metadata_field_tags::CAMERA_MODEL, &camera_model),
        MetadataSidecarField::new(metadata_field_tags::SUBSECONDS_MS, &subseconds),
        MetadataSidecarField::new(metadata_field_tags::GPS, &gps),
        MetadataSidecarField::new(metadata_field_tags::CODEC_FOURCC, &codec),
        MetadataSidecarField::new(metadata_field_tags::DURATION_MS, &video_duration),
        MetadataSidecarField::new(metadata_field_tags::FRAME_RATE_X100, &frame_rate),
        MetadataSidecarField::new(metadata_field_tags::VIDEO_ORIENTATION, &video_orientation),
        MetadataSidecarField::new(metadata_field_tags::VIDEO_DIMENSIONS, &video_dimensions),
        MetadataSidecarField::new(
            metadata_field_tags::VIDEO_CONTAINER_FORMAT,
            &video_container,
        ),
    ];

    let bytes = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &fields,
    )) {
        Ok(bytes) => bytes,
        Err(error) => panic!("worst-case active-tag sidecar should serialize: {error:?}"),
    };

    let expected_len = FIXED_METADATA_SIDECAR_HEADER_BYTES
        + (14 * TLV_RECORD_HEADER_BYTES)
        + orientation.len()
        + dimensions.len()
        + timestamp.len()
        + mime_override.len()
        + camera_make.len()
        + camera_model.len()
        + subseconds.len()
        + gps.len()
        + codec.len()
        + video_duration.len()
        + frame_rate.len()
        + video_orientation.len()
        + video_dimensions.len()
        + video_container.len();
    assert_eq!(bytes.len(), expected_len);
    assert_eq!(bytes.len(), 340);
    assert!(bytes.len() < MAX_SIDECAR_TOTAL_BYTES);
}

#[test]
fn encoder_rejects_out_of_range_gps_with_specific_error_code() {
    let mut gps = [0_u8; 14];
    gps[..4].copy_from_slice(&90_000_001_i32.to_le_bytes());
    gps[4..8].copy_from_slice(&0_i32.to_le_bytes());
    let fields = [MetadataSidecarField::new(metadata_field_tags::GPS, &gps)];

    let error = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &fields,
    )) {
        Ok(_) => panic!("out-of-range GPS latitude should fail"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        MetadataSidecarError::InvalidGpsValue {
            latitude_e7: 90_000_001,
            longitude_e7: 0,
        }
    );
}

#[test]
fn encoder_rejects_vendor_range_tag_4096() {
    let fields = [MetadataSidecarField::new(4096, b"vendor")];
    assert_eq!(
        canonical_metadata_sidecar_bytes(&MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 1, &fields)),
        Err(MetadataSidecarError::UnknownTag { tag: 4096 })
    );
}
#[test]
fn encoder_rejects_unknown_tag_500() {
    let fields = [MetadataSidecarField::new(500, b"unknown")];
    assert_eq!(
        canonical_metadata_sidecar_bytes(&MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 1, &fields)),
        Err(MetadataSidecarError::UnknownTag { tag: 500 })
    );
}
#[test]
fn encoder_accepts_active_orientation_tag_1() {
    let orientation = 1_u16.to_le_bytes();
    let fields = [MetadataSidecarField::new(
        metadata_field_tags::ORIENTATION,
        &orientation,
    )];
    let bytes = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &fields,
    )) {
        Ok(bytes) => bytes,
        Err(error) => panic!("active orientation should serialize: {error:?}"),
    };
    assert_eq!(
        &bytes[59..61],
        &metadata_field_tags::ORIENTATION.to_le_bytes()
    );
}
