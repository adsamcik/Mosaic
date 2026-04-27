use mosaic_domain::{
    EncryptedMetadataEnvelope, ManifestShardRef, ManifestTranscript, MetadataSidecar,
    MetadataSidecarError, MetadataSidecarField, ShardTier, canonical_manifest_transcript_bytes,
    canonical_metadata_sidecar_bytes, metadata_field_tags,
};

const ALBUM_ID: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const PHOTO_ID: [u8; 16] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];

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
    let filename = b"img.jpg";
    let fields = [
        MetadataSidecarField::new(metadata_field_tags::ORIENTATION, &orientation),
        MetadataSidecarField::new(metadata_field_tags::FILENAME, filename),
    ];
    let sidecar = MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 0x0102_0304, &fields);

    let bytes = match canonical_metadata_sidecar_bytes(&sidecar) {
        Ok(value) => value,
        Err(error) => panic!("metadata sidecar should serialize: {error:?}"),
    };

    assert_eq!(bytes.len(), 80);
    assert_eq!(
        hex(&bytes),
        "4d6f736169635f4d657461646174615f763101000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f04030201020000000100020000000600060007000000696d672e6a7067"
    );
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
    let filename = b"img.jpg";
    let unsorted = [
        MetadataSidecarField::new(metadata_field_tags::FILENAME, filename),
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
            previous: metadata_field_tags::FILENAME,
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
    let empty_value = [MetadataSidecarField::new(metadata_field_tags::CAPTION, &[])];

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
            tag: metadata_field_tags::CAPTION
        }
    );
}

#[test]
fn manifest_transcript_binds_encrypted_opaque_sidecar_envelope_bytes_not_plaintext_sidecar() {
    let filename = b"img.jpg";
    let fields = [MetadataSidecarField::new(
        metadata_field_tags::FILENAME,
        filename,
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
