use mosaic_client::{ClientErrorCode, crypto_domain_golden_vector_snapshot};
use mosaic_crypto::golden_vectors as crypto_vectors;
use mosaic_domain::{ShardEnvelopeHeader, golden_vectors as domain_vectors};

#[test]
fn native_crypto_domain_snapshot_matches_canonical_vectors() {
    let snapshot = crypto_domain_golden_vector_snapshot();

    assert_eq!(snapshot.code, ClientErrorCode::Ok);
    assert_eq!(
        snapshot.envelope_header,
        domain_vectors::envelope_header_bytes().to_vec()
    );

    let parsed_header = match ShardEnvelopeHeader::parse(&snapshot.envelope_header) {
        Ok(value) => value,
        Err(error) => panic!("snapshot envelope header should parse: {error:?}"),
    };
    assert_eq!(snapshot.envelope_epoch_id, parsed_header.epoch_id());
    assert_eq!(snapshot.envelope_shard_index, parsed_header.shard_index());
    assert_eq!(snapshot.envelope_tier, parsed_header.tier().to_byte());
    assert_eq!(snapshot.envelope_nonce, parsed_header.nonce().to_vec());

    let manifest_transcript = match domain_vectors::manifest_transcript_bytes() {
        Ok(value) => value,
        Err(error) => panic!("domain manifest vector should serialize: {error:?}"),
    };
    assert_eq!(snapshot.manifest_transcript, manifest_transcript);

    let identity_vector = match crypto_vectors::identity_public_vector() {
        Ok(value) => value,
        Err(error) => panic!("identity vector should derive: {error:?}"),
    };
    assert_eq!(
        snapshot.identity_message,
        crypto_vectors::IDENTITY_MESSAGE.to_vec()
    );
    assert_eq!(
        snapshot.identity_signing_pubkey,
        identity_vector.signing_pubkey().to_vec()
    );
    assert_eq!(
        snapshot.identity_encryption_pubkey,
        identity_vector.encryption_pubkey().to_vec()
    );
    assert_eq!(
        snapshot.identity_signature,
        identity_vector.signature().to_vec()
    );
}
