use mosaic_domain::{
    EncryptedMetadataEnvelope, ManifestShardRef, ManifestTranscript, ManifestTranscriptError,
    ShardTier, canonical_manifest_transcript_bytes,
};

const ALBUM_ID: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];

fn shard_ref(
    chunk_index: u32,
    tier: ShardTier,
    first_id_byte: u8,
    hash_byte: u8,
) -> ManifestShardRef {
    let mut shard_id = [0_u8; 16];
    for (offset, byte) in shard_id.iter_mut().enumerate() {
        *byte = first_id_byte + offset as u8;
    }

    ManifestShardRef::new(chunk_index, shard_id, tier, [hash_byte; 32])
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn encrypted_envelope(bytes: &[u8]) -> EncryptedMetadataEnvelope<'_> {
    EncryptedMetadataEnvelope::new(bytes)
}

#[test]
fn manifest_transcript_serializes_to_fixed_binary_vector() {
    let encrypted_meta = [0xaa, 0xbb, 0xcc];
    let shards = [
        shard_ref(1, ShardTier::Original, 0x20, 0x22),
        shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11),
    ];
    let transcript =
        ManifestTranscript::new(ALBUM_ID, 7, encrypted_envelope(&encrypted_meta), &shards);

    let bytes = match canonical_manifest_transcript_bytes(&transcript) {
        Ok(value) => value,
        Err(error) => panic!("manifest transcript should serialize: {error:?}"),
    };

    assert_eq!(bytes.len(), 156);
    assert_eq!(
        hex(&bytes),
        "4d6f736169635f4d616e69666573745f763101000102030405060708090a0b0c0d0e0f0700000003000000aabbcc020000000000000001101112131415161718191a1b1c1d1e1f11111111111111111111111111111111111111111111111111111111111111110100000003202122232425262728292a2b2c2d2e2f2222222222222222222222222222222222222222222222222222222222222222"
    );
}

#[test]
fn manifest_transcript_is_canonical_for_shard_order() {
    let encrypted_meta = [0x99, 0x88];
    let ordered = [
        shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11),
        shard_ref(1, ShardTier::Preview, 0x20, 0x22),
    ];
    let reversed = [ordered[1], ordered[0]];

    let ordered_bytes = match canonical_manifest_transcript_bytes(&ManifestTranscript::new(
        ALBUM_ID,
        3,
        encrypted_envelope(&encrypted_meta),
        &ordered,
    )) {
        Ok(value) => value,
        Err(error) => panic!("ordered transcript should serialize: {error:?}"),
    };
    let reversed_bytes = match canonical_manifest_transcript_bytes(&ManifestTranscript::new(
        ALBUM_ID,
        3,
        encrypted_envelope(&encrypted_meta),
        &reversed,
    )) {
        Ok(value) => value,
        Err(error) => panic!("reversed transcript should serialize canonically: {error:?}"),
    };

    assert_eq!(ordered_bytes, reversed_bytes);
}

#[test]
fn manifest_transcript_rejects_empty_encrypted_metadata() {
    let shards = [shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11)];
    let transcript = ManifestTranscript::new(ALBUM_ID, 1, encrypted_envelope(&[]), &shards);

    let error = match canonical_manifest_transcript_bytes(&transcript) {
        Ok(_) => panic!("empty encrypted metadata should fail"),
        Err(error) => error,
    };

    assert_eq!(error, ManifestTranscriptError::EmptyEncryptedMeta);
}

#[test]
fn manifest_transcript_rejects_empty_shard_list() {
    let encrypted_meta = [0xaa];
    let transcript = ManifestTranscript::new(ALBUM_ID, 1, encrypted_envelope(&encrypted_meta), &[]);

    let error = match canonical_manifest_transcript_bytes(&transcript) {
        Ok(_) => panic!("empty shard list should fail"),
        Err(error) => error,
    };

    assert_eq!(error, ManifestTranscriptError::EmptyShardList);
}

#[test]
fn manifest_transcript_rejects_duplicate_or_missing_indices() {
    let encrypted_meta = [0xaa];
    let duplicate = [
        shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11),
        shard_ref(0, ShardTier::Preview, 0x20, 0x22),
    ];
    let missing_zero = [shard_ref(1, ShardTier::Preview, 0x20, 0x22)];

    let duplicate_error = match canonical_manifest_transcript_bytes(&ManifestTranscript::new(
        ALBUM_ID,
        1,
        encrypted_envelope(&encrypted_meta),
        &duplicate,
    )) {
        Ok(_) => panic!("duplicate shard index should fail"),
        Err(error) => error,
    };
    assert_eq!(
        duplicate_error,
        ManifestTranscriptError::NonSequentialShardIndex {
            expected: 1,
            actual: 0
        }
    );

    let missing_error = match canonical_manifest_transcript_bytes(&ManifestTranscript::new(
        ALBUM_ID,
        1,
        encrypted_envelope(&encrypted_meta),
        &missing_zero,
    )) {
        Ok(_) => panic!("missing zero index should fail"),
        Err(error) => error,
    };
    assert_eq!(
        missing_error,
        ManifestTranscriptError::NonSequentialShardIndex {
            expected: 0,
            actual: 1
        }
    );
}

#[test]
fn manifest_transcript_reports_first_gap_after_sorting_shards() {
    let encrypted_meta = [0xaa];
    let shards = [
        shard_ref(3, ShardTier::Original, 0x30, 0x33),
        shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11),
        shard_ref(2, ShardTier::Preview, 0x20, 0x22),
    ];

    let error = match canonical_manifest_transcript_bytes(&ManifestTranscript::new(
        ALBUM_ID,
        1,
        encrypted_envelope(&encrypted_meta),
        &shards,
    )) {
        Ok(_) => panic!("gap in sorted shard indices should fail"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        ManifestTranscriptError::NonSequentialShardIndex {
            expected: 1,
            actual: 2
        }
    );
}
