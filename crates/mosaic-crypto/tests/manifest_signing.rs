use mosaic_crypto::{
    ManifestSignature, ManifestSigningPublicKey, ManifestSigningSecretKey, MosaicCryptoError,
    generate_manifest_signing_keypair, sign_manifest_transcript, verify_manifest_transcript,
};
use mosaic_domain::{
    ManifestShardRef, ManifestTranscript, ShardTier, canonical_manifest_transcript_bytes,
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

fn canonical_transcript() -> Vec<u8> {
    let encrypted_meta = [0xaa, 0xbb, 0xcc];
    let shards = [
        shard_ref(1, ShardTier::Original, 0x20, 0x22),
        shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11),
    ];

    match canonical_manifest_transcript_bytes(&ManifestTranscript::new(
        ALBUM_ID,
        7,
        &encrypted_meta,
        &shards,
    )) {
        Ok(value) => value,
        Err(error) => panic!("manifest transcript should serialize: {error:?}"),
    }
}

fn fixed_seed() -> [u8; 32] {
    let mut seed = [0_u8; 32];
    for (index, byte) in seed.iter_mut().enumerate() {
        *byte = index as u8;
    }
    seed
}

fn fixed_secret_key() -> ManifestSigningSecretKey {
    let mut seed = fixed_seed();
    match ManifestSigningSecretKey::from_seed(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("fixed signing seed should be accepted: {error:?}"),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[test]
fn fixed_seed_signing_matches_libsodium_vector() {
    let secret_key = fixed_secret_key();
    let public_key = secret_key.public_key();
    let transcript = canonical_transcript();

    let signature = sign_manifest_transcript(&transcript, &secret_key);

    assert!(
        hex(public_key.as_bytes())
            == "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8"
    );
    assert!(
        hex(signature.as_bytes())
            == "db7da212949a52945bdf9eb683970d307e9b780f461ad67a15dc00883dd069e55c6fe5f8e78e545f28476c7d2c00b5351c6bf1db9dfd76bf0ae22cc479cb3e0c"
    );
    assert!(verify_manifest_transcript(
        &transcript,
        &signature,
        &public_key
    ));
}

#[test]
fn manifest_signature_is_deterministic_for_same_key_and_transcript() {
    let secret_key = fixed_secret_key();
    let transcript = canonical_transcript();

    let first = sign_manifest_transcript(&transcript, &secret_key);
    let second = sign_manifest_transcript(&transcript, &secret_key);

    assert!(first.as_bytes() == second.as_bytes());
}

#[test]
fn generated_keypair_signs_and_verifies_manifest_transcript() {
    let keypair = match generate_manifest_signing_keypair() {
        Ok(value) => value,
        Err(error) => panic!("manifest signing keypair should generate: {error:?}"),
    };
    let transcript = canonical_transcript();

    let signature = sign_manifest_transcript(&transcript, keypair.secret_key());

    assert!(verify_manifest_transcript(
        &transcript,
        &signature,
        keypair.public_key()
    ));
}

#[test]
fn generated_manifest_signing_keypairs_are_fresh() {
    let first = match generate_manifest_signing_keypair() {
        Ok(value) => value,
        Err(error) => panic!("first manifest signing keypair should generate: {error:?}"),
    };
    let second = match generate_manifest_signing_keypair() {
        Ok(value) => value,
        Err(error) => panic!("second manifest signing keypair should generate: {error:?}"),
    };

    assert!(first.public_key().as_bytes() != second.public_key().as_bytes());
}

#[test]
fn verification_fails_for_tampered_transcript_signature_and_wrong_key() {
    let secret_key = fixed_secret_key();
    let wrong_key = {
        let mut seed = [0x42_u8; 32];
        match ManifestSigningSecretKey::from_seed(&mut seed) {
            Ok(value) => value,
            Err(error) => panic!("wrong signing seed should be accepted: {error:?}"),
        }
    };
    let transcript = canonical_transcript();
    let signature = sign_manifest_transcript(&transcript, &secret_key);
    let public_key = secret_key.public_key();

    let mut tampered_transcript = transcript.clone();
    tampered_transcript[0] ^= 0x01;
    assert!(!verify_manifest_transcript(
        &tampered_transcript,
        &signature,
        &public_key
    ));

    let mut tampered_signature_bytes = *signature.as_bytes();
    tampered_signature_bytes[0] ^= 0x01;
    let tampered_signature = match ManifestSignature::from_bytes(&tampered_signature_bytes) {
        Ok(value) => value,
        Err(error) => panic!("tampered signature length is still valid: {error:?}"),
    };
    assert!(!verify_manifest_transcript(
        &transcript,
        &tampered_signature,
        &public_key
    ));

    assert!(!verify_manifest_transcript(
        &transcript,
        &signature,
        &wrong_key.public_key()
    ));
}

#[test]
fn public_key_and_signature_constructors_reject_bad_lengths() {
    let public_key_error = match ManifestSigningPublicKey::from_bytes(&[0_u8; 31]) {
        Ok(_) => panic!("short Ed25519 public key should fail"),
        Err(error) => error,
    };
    assert_eq!(
        public_key_error,
        MosaicCryptoError::InvalidKeyLength { actual: 31 }
    );

    let signature_error = match ManifestSignature::from_bytes(&[0_u8; 63]) {
        Ok(_) => panic!("short Ed25519 signature should fail"),
        Err(error) => error,
    };
    assert_eq!(
        signature_error,
        MosaicCryptoError::InvalidSignatureLength { actual: 63 }
    );
}

#[test]
fn signing_seed_constructor_zeroizes_source_on_success_and_invalid_length() {
    let mut seed = fixed_seed();
    let secret_key = match ManifestSigningSecretKey::from_seed(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("fixed signing seed should be accepted: {error:?}"),
    };

    assert_eq!(secret_key.public_key().as_bytes().len(), 32);
    assert!(seed.iter().all(|byte| *byte == 0));

    let mut short_seed = [0x7a_u8; 31];
    let error = match ManifestSigningSecretKey::from_seed(&mut short_seed) {
        Ok(_) => panic!("short signing seed should fail"),
        Err(error) => error,
    };

    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 31 });
    assert!(short_seed.iter().all(|byte| *byte == 0));
}

#[test]
fn public_key_constructor_rejects_weak_ed25519_points() {
    let mut weak_identity_point = [0_u8; 32];
    weak_identity_point[0] = 1;
    let error = match ManifestSigningPublicKey::from_bytes(&weak_identity_point) {
        Ok(_) => panic!("weak Ed25519 identity point should fail"),
        Err(error) => error,
    };

    assert_eq!(error, MosaicCryptoError::InvalidPublicKey);
}
