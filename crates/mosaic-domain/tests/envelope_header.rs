use mosaic_domain::{
    MosaicDomainError, SHARD_ENVELOPE_HEADER_LEN, SHARD_ENVELOPE_VERSION, ShardEnvelopeHeader,
    ShardTier,
};

const NONCE: [u8; 24] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
];

#[test]
fn shard_header_serializes_to_protocol_bytes() {
    let header = ShardEnvelopeHeader::new(0x0102_0304, 0x0506_0708, NONCE, ShardTier::Preview);

    let bytes = header.to_bytes();

    assert_eq!(bytes.len(), SHARD_ENVELOPE_HEADER_LEN);
    assert_eq!(&bytes[0..4], b"SGzk");
    assert_eq!(bytes[4], SHARD_ENVELOPE_VERSION);
    assert_eq!(&bytes[5..9], &[0x04, 0x03, 0x02, 0x01]);
    assert_eq!(&bytes[9..13], &[0x08, 0x07, 0x06, 0x05]);
    assert_eq!(&bytes[13..37], NONCE.as_slice());
    assert_eq!(bytes[37], 2);
    assert!(bytes[38..64].iter().all(|value| *value == 0));
}

#[test]
fn shard_header_parses_original_raw_bytes() {
    let header = ShardEnvelopeHeader::new(42, 7, NONCE, ShardTier::Original);
    let bytes = header.to_bytes();

    let parsed = match ShardEnvelopeHeader::parse(&bytes) {
        Ok(value) => value,
        Err(error) => panic!("valid header should parse: {error:?}"),
    };

    assert_eq!(parsed, header);
    assert_eq!(parsed.to_bytes(), bytes);
}

#[test]
fn shard_header_rejects_only_non_exact_boundary_lengths_as_length_errors() {
    let bytes = ShardEnvelopeHeader::new(42, 7, NONCE, ShardTier::Original).to_bytes();

    assert!(ShardEnvelopeHeader::parse(&bytes).is_ok());
    assert_eq!(
        ShardEnvelopeHeader::parse(&bytes[..SHARD_ENVELOPE_HEADER_LEN - 1]),
        Err(MosaicDomainError::InvalidHeaderLength {
            actual: SHARD_ENVELOPE_HEADER_LEN - 1
        })
    );

    let mut too_long = bytes.to_vec();
    too_long.push(0);
    assert_eq!(
        ShardEnvelopeHeader::parse(&too_long),
        Err(MosaicDomainError::InvalidHeaderLength {
            actual: SHARD_ENVELOPE_HEADER_LEN + 1
        })
    );
}

#[test]
fn shard_header_rejects_non_zero_reserved_before_decrypt() {
    let mut bytes = ShardEnvelopeHeader::new(42, 7, NONCE, ShardTier::Thumbnail).to_bytes();
    bytes[63] = 1;

    let error = match ShardEnvelopeHeader::parse(&bytes) {
        Ok(value) => panic!("reserved bytes should fail, parsed: {value:?}"),
        Err(error) => error,
    };

    assert_eq!(error, MosaicDomainError::NonZeroReservedByte { offset: 63 });
}

#[test]
fn shard_header_rejects_every_reserved_byte_offset() {
    for offset in 38..SHARD_ENVELOPE_HEADER_LEN {
        let mut bytes = ShardEnvelopeHeader::new(42, 7, NONCE, ShardTier::Thumbnail).to_bytes();
        bytes[offset] = 1;

        assert_eq!(
            ShardEnvelopeHeader::parse(&bytes),
            Err(MosaicDomainError::NonZeroReservedByte { offset })
        );
    }
}

#[test]
fn shard_tier_accepts_only_defined_protocol_values() {
    assert_eq!(ShardTier::try_from(1), Ok(ShardTier::Thumbnail));
    assert_eq!(ShardTier::try_from(2), Ok(ShardTier::Preview));
    assert_eq!(ShardTier::try_from(3), Ok(ShardTier::Original));

    assert_eq!(
        ShardTier::try_from(0),
        Err(MosaicDomainError::InvalidTier { value: 0 })
    );
    for value in 4..=u8::MAX {
        assert_eq!(
            ShardTier::try_from(value),
            Err(MosaicDomainError::InvalidTier { value })
        );
    }
}
