use mosaic_crypto::{
    AUTH_CHALLENGE_CONTEXT, AuthSignature, AuthSigningPublicKey, AuthSigningSecretKey, KdfProfile,
    MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB, MosaicCryptoError, build_auth_challenge_transcript,
    derive_auth_signing_keypair, sign_auth_challenge, verify_auth_challenge,
};
use zeroize::Zeroizing;

const PASSWORD: &[u8] = b"correct horse battery staple";
const WRONG_PASSWORD: &[u8] = b"wrong horse battery staple";
const USERNAME: &str = "alice@example.com";
const TIMESTAMP_MS: u64 = 1_714_212_345_678;
const USER_SALT: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const OTHER_USER_SALT: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];
const CHALLENGE: [u8; 32] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
    0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf,
];

fn minimum_profile() -> KdfProfile {
    match KdfProfile::new(MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic profile should be valid: {error:?}"),
    }
}

fn fixed_auth_keypair() -> mosaic_crypto::AuthSigningKeypair {
    match derive_auth_signing_keypair(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        minimum_profile(),
    ) {
        Ok(value) => value,
        Err(error) => panic!("auth signing keypair should derive: {error:?}"),
    }
}

#[cfg(not(feature = "weak-kdf"))]
fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[test]
#[cfg(not(feature = "weak-kdf"))]
fn fixed_password_auth_signing_matches_python_vector() {
    let keypair = fixed_auth_keypair();
    let transcript = match build_auth_challenge_transcript(USERNAME, Some(TIMESTAMP_MS), &CHALLENGE)
    {
        Ok(value) => value,
        Err(error) => panic!("auth transcript should build: {error:?}"),
    };

    let signature = sign_auth_challenge(&transcript, keypair.secret_key());

    assert!(
        hex(keypair.public_key().as_bytes())
            == "7aa89c913149f720abfa780b8be16b7e810b0974f043274f5af91d1f8227717b"
    );
    assert!(
        hex(&transcript)
            == "4d6f736169635f417574685f4368616c6c656e67655f763100000011616c696365406578616d706c652e636f6d0000018f1f04974ea0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf"
    );
    assert!(
        hex(signature.as_bytes())
            == "3aec13b96c055ec24acb26566bf64dff346c3335835ec2d470802b92f645361c5e880e9d608577df4dd86527b3b1c69bd8d337d752dc0dd6ae00b4fab6f70202"
    );
    assert!(verify_auth_challenge(
        &transcript,
        &signature,
        keypair.public_key()
    ));
}

#[test]
#[cfg(not(feature = "weak-kdf"))]
fn auth_transcript_without_timestamp_matches_backend_format() {
    let keypair = fixed_auth_keypair();
    let transcript = match build_auth_challenge_transcript(USERNAME, None, &CHALLENGE) {
        Ok(value) => value,
        Err(error) => panic!("auth transcript without timestamp should build: {error:?}"),
    };

    let signature = sign_auth_challenge(&transcript, keypair.secret_key());

    assert!(
        hex(&transcript)
            == "4d6f736169635f417574685f4368616c6c656e67655f763100000011616c696365406578616d706c652e636f6da0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf"
    );
    assert!(
        hex(signature.as_bytes())
            == "aeeeff58d7e18ebcd07f9c4d9747d528278e7f616b308434fff755ae5547c9b49b5ad8005f2a9441acb84e90206e69abac13f2563110762fa9124c9c5c53c608"
    );
    assert!(verify_auth_challenge(
        &transcript,
        &signature,
        keypair.public_key()
    ));
}

#[test]
fn auth_transcript_validates_username_edges_and_timestamp_boundaries() {
    assert_eq!(
        build_auth_challenge_transcript("", None, &CHALLENGE),
        Err(MosaicCryptoError::InvalidUsername)
    );
    assert_eq!(
        build_auth_challenge_transcript("user\0name", None, &CHALLENGE),
        Err(MosaicCryptoError::InvalidUsername)
    );
    assert_eq!(
        build_auth_challenge_transcript("user\nname", None, &CHALLENGE),
        Err(MosaicCryptoError::InvalidUsername)
    );

    let max_username = "a".repeat(256);
    let expected_len = AUTH_CHALLENGE_CONTEXT.len() + 4 + max_username.len() + 8 + CHALLENGE.len();
    let username_len_offset = AUTH_CHALLENGE_CONTEXT.len();
    let username_offset = username_len_offset + 4;
    let timestamp_offset = username_offset + max_username.len();
    let expected_username_len = 256_u32.to_be_bytes();

    let zero_timestamp = match build_auth_challenge_transcript(&max_username, Some(0), &CHALLENGE) {
        Ok(value) => value,
        Err(error) => panic!("maximum valid username with zero timestamp should build: {error:?}"),
    };

    assert_eq!(zero_timestamp.len(), expected_len);
    assert_eq!(
        &zero_timestamp[username_len_offset..username_offset],
        expected_username_len.as_slice()
    );
    assert_eq!(
        &zero_timestamp[timestamp_offset..timestamp_offset + 8],
        0_u64.to_be_bytes().as_slice()
    );
    assert_eq!(
        &zero_timestamp[timestamp_offset + 8..],
        CHALLENGE.as_slice()
    );

    let max_timestamp =
        match build_auth_challenge_transcript(&max_username, Some(u64::MAX), &CHALLENGE) {
            Ok(value) => value,
            Err(error) => {
                panic!("maximum valid username with maximum timestamp should build: {error:?}")
            }
        };

    assert_eq!(max_timestamp.len(), expected_len);
    assert_eq!(
        &max_timestamp[timestamp_offset..timestamp_offset + 8],
        u64::MAX.to_be_bytes().as_slice()
    );
    assert_eq!(&max_timestamp[timestamp_offset + 8..], CHALLENGE.as_slice());
}

#[test]
fn auth_key_derivation_is_deterministic_and_password_salt_bound() {
    let first = fixed_auth_keypair();
    let second = fixed_auth_keypair();
    let wrong_password = match derive_auth_signing_keypair(
        Zeroizing::new(WRONG_PASSWORD.to_vec()),
        &USER_SALT,
        minimum_profile(),
    ) {
        Ok(value) => value,
        Err(error) => panic!("wrong-password auth keypair should still derive: {error:?}"),
    };
    let wrong_salt = match derive_auth_signing_keypair(
        Zeroizing::new(PASSWORD.to_vec()),
        &OTHER_USER_SALT,
        minimum_profile(),
    ) {
        Ok(value) => value,
        Err(error) => panic!("wrong-salt auth keypair should still derive: {error:?}"),
    };

    assert!(first.public_key().as_bytes() == second.public_key().as_bytes());
    assert!(first.public_key().as_bytes() != wrong_password.public_key().as_bytes());
    assert!(first.public_key().as_bytes() != wrong_salt.public_key().as_bytes());
}

#[test]
fn verification_fails_for_tampered_transcript_signature_and_wrong_key() {
    let keypair = fixed_auth_keypair();
    let wrong_key = match derive_auth_signing_keypair(
        Zeroizing::new(WRONG_PASSWORD.to_vec()),
        &USER_SALT,
        minimum_profile(),
    ) {
        Ok(value) => value,
        Err(error) => panic!("wrong-password auth keypair should derive: {error:?}"),
    };
    let transcript = match build_auth_challenge_transcript(USERNAME, Some(TIMESTAMP_MS), &CHALLENGE)
    {
        Ok(value) => value,
        Err(error) => panic!("auth transcript should build: {error:?}"),
    };
    let signature = sign_auth_challenge(&transcript, keypair.secret_key());

    let mut tampered_transcript = transcript.clone();
    tampered_transcript[0] ^= 0x01;
    assert!(!verify_auth_challenge(
        &tampered_transcript,
        &signature,
        keypair.public_key()
    ));

    let mut tampered_signature_bytes = *signature.as_bytes();
    tampered_signature_bytes[0] ^= 0x01;
    let tampered_signature = match AuthSignature::from_bytes(&tampered_signature_bytes) {
        Ok(value) => value,
        Err(error) => panic!("tampered signature length is still valid: {error:?}"),
    };
    assert!(!verify_auth_challenge(
        &transcript,
        &tampered_signature,
        keypair.public_key()
    ));

    assert!(!verify_auth_challenge(
        &transcript,
        &signature,
        wrong_key.public_key()
    ));
}

#[test]
fn auth_inputs_validate_lengths_username_and_weak_keys() {
    let short_salt = match derive_auth_signing_keypair(
        Zeroizing::new(PASSWORD.to_vec()),
        &[0_u8; 15],
        minimum_profile(),
    ) {
        Ok(_) => panic!("short user salt should fail"),
        Err(error) => error,
    };
    assert_eq!(
        short_salt,
        MosaicCryptoError::InvalidSaltLength { actual: 15 }
    );

    let short_challenge = match build_auth_challenge_transcript(USERNAME, None, &[0_u8; 31]) {
        Ok(_) => panic!("short auth challenge should fail"),
        Err(error) => error,
    };
    assert_eq!(
        short_challenge,
        MosaicCryptoError::InvalidInputLength { actual: 31 }
    );

    assert_eq!(
        build_auth_challenge_transcript("  ", None, &CHALLENGE),
        Err(MosaicCryptoError::InvalidUsername)
    );
    assert_eq!(
        build_auth_challenge_transcript(" alice", None, &CHALLENGE),
        Err(MosaicCryptoError::InvalidUsername)
    );
    assert_eq!(
        build_auth_challenge_transcript("alice!", None, &CHALLENGE),
        Err(MosaicCryptoError::InvalidUsername)
    );
    assert_eq!(
        build_auth_challenge_transcript(&"a".repeat(257), None, &CHALLENGE),
        Err(MosaicCryptoError::InvalidUsername)
    );

    let short_public_key = match AuthSigningPublicKey::from_bytes(&[0_u8; 31]) {
        Ok(_) => panic!("short auth public key should fail"),
        Err(error) => error,
    };
    assert_eq!(
        short_public_key,
        MosaicCryptoError::InvalidKeyLength { actual: 31 }
    );

    let short_signature = match AuthSignature::from_bytes(&[0_u8; 63]) {
        Ok(_) => panic!("short auth signature should fail"),
        Err(error) => error,
    };
    assert_eq!(
        short_signature,
        MosaicCryptoError::InvalidSignatureLength { actual: 63 }
    );

    let mut weak_identity_point = [0_u8; 32];
    weak_identity_point[0] = 1;
    let weak_public_key = match AuthSigningPublicKey::from_bytes(&weak_identity_point) {
        Ok(_) => panic!("weak auth public key should fail"),
        Err(error) => error,
    };
    assert_eq!(weak_public_key, MosaicCryptoError::InvalidPublicKey);
}

#[test]
fn auth_secret_constructor_zeroizes_source_on_success_and_invalid_length() {
    let mut seed = [0x5a_u8; 32];
    let secret_key = match AuthSigningSecretKey::from_seed(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("auth signing seed should be accepted: {error:?}"),
    };

    assert_eq!(secret_key.public_key().as_bytes().len(), 32);
    assert!(seed.iter().all(|byte| *byte == 0));

    let mut short_seed = [0x7a_u8; 31];
    let error = match AuthSigningSecretKey::from_seed(&mut short_seed) {
        Ok(_) => panic!("short auth signing seed should fail"),
        Err(error) => error,
    };

    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 31 });
    assert!(short_seed.iter().all(|byte| *byte == 0));
}
