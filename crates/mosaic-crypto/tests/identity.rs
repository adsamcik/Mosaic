use mosaic_crypto::{
    IdentitySignature, IdentitySigningPublicKey, IdentitySigningSecretKey, MosaicCryptoError,
    derive_identity_keypair, identity_encryption_public_key_from_signing_public_key,
    sign_manifest_with_identity, verify_manifest_identity_signature,
};

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[test]
fn fixed_identity_seed_matches_ed25519_and_x25519_vectors() {
    let mut seed = [
        0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
        0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
        0x7f, 0x60,
    ];

    let keypair = match derive_identity_keypair(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("identity seed should derive: {error:?}"),
    };

    assert!(seed.iter().all(|byte| *byte == 0));
    assert_eq!(
        hex(keypair.signing_public_key().as_bytes()),
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    );
    assert_eq!(
        hex(keypair.encryption_public_key().as_bytes()),
        "d85e07ec22b0ad881537c2f44d662d1a143cf830c57aca4305d85c7a90f6b62e"
    );
}

#[test]
fn identity_signing_signs_and_verifies_manifest_transcript() {
    let mut seed = [0x42_u8; 32];
    let keypair = match derive_identity_keypair(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("identity seed should derive: {error:?}"),
    };
    let transcript = b"mosaic identity manifest transcript";

    let signature = sign_manifest_with_identity(transcript, keypair.secret_key());

    assert!(verify_manifest_identity_signature(
        transcript,
        &signature,
        keypair.signing_public_key()
    ));

    let mut tampered_signature_bytes = *signature.as_bytes();
    tampered_signature_bytes[0] ^= 1;
    let tampered_signature = match IdentitySignature::from_bytes(&tampered_signature_bytes) {
        Ok(value) => value,
        Err(error) => panic!("tampered signature length remains valid: {error:?}"),
    };
    assert!(!verify_manifest_identity_signature(
        transcript,
        &tampered_signature,
        keypair.signing_public_key()
    ));
}

#[test]
fn identity_keypair_zeroize_secret_wipes_signing_seed() {
    let mut seed = [0x42_u8; 32];
    let mut keypair = match derive_identity_keypair(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("identity seed should derive: {error:?}"),
    };
    let public_key = *keypair.signing_public_key();
    let transcript = b"mosaic identity manifest transcript";

    let signature = sign_manifest_with_identity(transcript, keypair.secret_key());
    assert!(verify_manifest_identity_signature(
        transcript,
        &signature,
        &public_key
    ));

    keypair.zeroize_secret();
    let wiped_signature = sign_manifest_with_identity(transcript, keypair.secret_key());
    assert!(!verify_manifest_identity_signature(
        transcript,
        &wiped_signature,
        &public_key
    ));
}

#[test]
fn identity_seed_constructor_zeroizes_source_on_success_and_invalid_length() {
    let mut seed = [0x7a_u8; 32];
    let secret_key = match IdentitySigningSecretKey::from_seed(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("identity seed should be accepted: {error:?}"),
    };

    assert_eq!(secret_key.public_key().as_bytes().len(), 32);
    assert!(seed.iter().all(|byte| *byte == 0));

    let mut short_seed = [0x7a_u8; 31];
    let error = match IdentitySigningSecretKey::from_seed(&mut short_seed) {
        Ok(_) => panic!("short identity seed should fail"),
        Err(error) => error,
    };

    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 31 });
    assert!(short_seed.iter().all(|byte| *byte == 0));
}

#[test]
fn identity_public_key_validation_rejects_bad_lengths_and_weak_points() {
    let length_error = match IdentitySigningPublicKey::from_bytes(&[0_u8; 31]) {
        Ok(_) => panic!("short identity public key should fail"),
        Err(error) => error,
    };
    assert_eq!(
        length_error,
        MosaicCryptoError::InvalidKeyLength { actual: 31 }
    );

    let mut weak_identity_point = [0_u8; 32];
    weak_identity_point[0] = 1;
    let weak_error = match IdentitySigningPublicKey::from_bytes(&weak_identity_point) {
        Ok(_) => panic!("weak identity point should fail"),
        Err(error) => error,
    };
    assert_eq!(weak_error, MosaicCryptoError::InvalidPublicKey);

    let conversion_error =
        match identity_encryption_public_key_from_signing_public_key(&weak_identity_point) {
            Ok(_) => panic!("weak identity point should not convert"),
            Err(error) => error,
        };
    assert_eq!(conversion_error, MosaicCryptoError::InvalidPublicKey);
}
