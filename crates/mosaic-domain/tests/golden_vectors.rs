use mosaic_domain::{ShardEnvelopeHeader, ShardTier, golden_vectors};

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[test]
fn envelope_header_golden_vector_is_fixed_protocol_bytes() {
    let bytes = golden_vectors::envelope_header_bytes();

    assert_eq!(
        hex(&bytes),
        "53477a6b030403020108070605101112131415161718191a1b1c1d1e1f2021222324252627020000000000000000000000000000000000000000000000000000"
    );

    let parsed = match ShardEnvelopeHeader::parse(&bytes) {
        Ok(value) => value,
        Err(error) => panic!("golden envelope header should parse: {error:?}"),
    };
    assert_eq!(
        parsed,
        ShardEnvelopeHeader::new(
            golden_vectors::ENVELOPE_EPOCH_ID,
            golden_vectors::ENVELOPE_SHARD_INDEX,
            golden_vectors::ENVELOPE_NONCE,
            ShardTier::Preview,
        )
    );
}

#[test]
fn manifest_transcript_golden_vector_is_fixed_canonical_bytes() {
    let bytes = match golden_vectors::manifest_transcript_bytes() {
        Ok(value) => value,
        Err(error) => panic!("golden manifest transcript should serialize: {error:?}"),
    };

    assert_eq!(bytes.len(), 156);
    assert_eq!(
        hex(&bytes),
        "4d6f736169635f4d616e69666573745f763101000102030405060708090a0b0c0d0e0f0700000003000000aabbcc020000000000000001101112131415161718191a1b1c1d1e1f11111111111111111111111111111111111111111111111111111111111111110100000003202122232425262728292a2b2c2d2e2f2222222222222222222222222222222222222222222222222222222222222222"
    );
}
