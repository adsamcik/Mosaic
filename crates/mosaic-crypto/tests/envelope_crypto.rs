use mosaic_crypto::{
    AuthSigningSecretKey, IdentitySigningSecretKey, ManifestSigningSecretKey, MosaicCryptoError,
    SecretKey, decrypt_shard, encrypt_shard, sha256_bytes, unwrap_key, wrap_key,
};
use mosaic_domain::{SHARD_ENVELOPE_HEADER_LEN, ShardEnvelopeHeader, ShardTier};

const KEY_BYTES: [u8; 32] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];

const WRONG_KEY_BYTES: [u8; 32] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
    0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef,
];

fn secret_key_from(mut bytes: [u8; 32]) -> SecretKey {
    match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("test key bytes should be accepted: {error:?}"),
    }
}

#[test]
fn secret_key_constructor_zeroizes_source_and_rejects_bad_length() {
    let mut bytes = [0x42_u8; 32];
    let key = match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("test key bytes should be accepted: {error:?}"),
    };

    assert!(key.as_bytes().iter().all(|byte| *byte == 0x42));
    assert!(bytes.iter().all(|byte| *byte == 0));

    let mut short_key = [0_u8; 31];
    let error = match SecretKey::from_bytes(&mut short_key) {
        Ok(_) => panic!("short key should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 31 });
    assert!(short_key.iter().all(|byte| *byte == 0));

    let mut empty_key = Vec::new();
    let error = match SecretKey::from_bytes(empty_key.as_mut_slice()) {
        Ok(_) => panic!("empty key should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 0 });

    let mut long_key = [0x55_u8; 33];
    let error = match SecretKey::from_bytes(&mut long_key) {
        Ok(_) => panic!("long key should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 33 });
    assert!(long_key.iter().all(|byte| *byte == 0));
}

#[test]
fn signing_seed_constructors_zeroize_sources_on_success_and_error() {
    let mut manifest_seed = [0x11_u8; 32];
    let _manifest_key = match ManifestSigningSecretKey::from_seed(&mut manifest_seed) {
        Ok(value) => value,
        Err(error) => panic!("manifest signing seed should be accepted: {error:?}"),
    };
    assert!(manifest_seed.iter().all(|byte| *byte == 0));

    let mut auth_seed = [0x22_u8; 32];
    let _auth_key = match AuthSigningSecretKey::from_seed(&mut auth_seed) {
        Ok(value) => value,
        Err(error) => panic!("auth signing seed should be accepted: {error:?}"),
    };
    assert!(auth_seed.iter().all(|byte| *byte == 0));

    let mut identity_seed = [0x33_u8; 32];
    let _identity_key = match IdentitySigningSecretKey::from_seed(&mut identity_seed) {
        Ok(value) => value,
        Err(error) => panic!("identity signing seed should be accepted: {error:?}"),
    };
    assert!(identity_seed.iter().all(|byte| *byte == 0));

    let mut short_seed = [0x44_u8; 31];
    let error = match ManifestSigningSecretKey::from_seed(&mut short_seed) {
        Ok(_) => panic!("short signing seed should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 31 });
    assert!(short_seed.iter().all(|byte| *byte == 0));
}

#[test]
fn shard_encryption_round_trips_with_header_aad_and_hash() {
    let key = secret_key_from(KEY_BYTES);
    let plaintext = b"mosaic encrypted shard bytes";

    let encrypted = match encrypt_shard(plaintext, &key, 7, 3, ShardTier::Original) {
        Ok(value) => value,
        Err(error) => panic!("shard should encrypt: {error:?}"),
    };

    assert_eq!(
        encrypted.bytes.len(),
        SHARD_ENVELOPE_HEADER_LEN + plaintext.len() + 16
    );
    assert_eq!(encrypted.sha256, sha256_bytes(&encrypted.bytes));

    let header = match ShardEnvelopeHeader::parse(&encrypted.bytes[..SHARD_ENVELOPE_HEADER_LEN]) {
        Ok(value) => value,
        Err(error) => panic!("encrypted header should parse: {error:?}"),
    };
    assert_eq!(header.epoch_id(), 7);
    assert_eq!(header.shard_index(), 3);
    assert_eq!(header.tier(), ShardTier::Original);

    let decrypted = match decrypt_shard(&encrypted.bytes, &key) {
        Ok(value) => value,
        Err(error) => panic!("shard should decrypt: {error:?}"),
    };

    assert_eq!(decrypted.as_slice(), plaintext);
}

#[test]
fn shard_encryption_generates_fresh_nonce_inside_crypto() {
    let key = secret_key_from(KEY_BYTES);
    let plaintext = b"same plaintext";

    let first = match encrypt_shard(plaintext, &key, 1, 0, ShardTier::Preview) {
        Ok(value) => value,
        Err(error) => panic!("first shard should encrypt: {error:?}"),
    };
    let second = match encrypt_shard(plaintext, &key, 1, 0, ShardTier::Preview) {
        Ok(value) => value,
        Err(error) => panic!("second shard should encrypt: {error:?}"),
    };

    assert_ne!(&first.bytes[13..37], &second.bytes[13..37]);
    assert_ne!(first.bytes, second.bytes);
}

#[test]
fn shard_decryption_rejects_wrong_key_tampered_header_and_header_only_envelope() {
    let key = secret_key_from(KEY_BYTES);
    let wrong_key = secret_key_from(WRONG_KEY_BYTES);

    let encrypted = match encrypt_shard(b"authenticated", &key, 2, 9, ShardTier::Thumbnail) {
        Ok(value) => value,
        Err(error) => panic!("shard should encrypt: {error:?}"),
    };

    let wrong_key_error = match decrypt_shard(&encrypted.bytes, &wrong_key) {
        Ok(_) => panic!("wrong key should fail"),
        Err(error) => error,
    };
    assert_eq!(wrong_key_error, MosaicCryptoError::AuthenticationFailed);

    let mut tampered_header = encrypted.bytes.clone();
    tampered_header[5] ^= 0x01;
    let tampered_error = match decrypt_shard(&tampered_header, &key) {
        Ok(_) => panic!("tampered AAD should fail"),
        Err(error) => error,
    };
    assert_eq!(tampered_error, MosaicCryptoError::AuthenticationFailed);

    let header_only_error = match decrypt_shard(&encrypted.bytes[..SHARD_ENVELOPE_HEADER_LEN], &key)
    {
        Ok(_) => panic!("header-only envelope should fail"),
        Err(error) => error,
    };
    assert_eq!(header_only_error, MosaicCryptoError::MissingCiphertext);
}

#[test]
fn shard_decryption_classifies_structural_and_authenticated_tampering() {
    let key = secret_key_from(KEY_BYTES);
    let encrypted = match encrypt_shard(b"authenticated", &key, 2, 9, ShardTier::Thumbnail) {
        Ok(value) => value,
        Err(error) => panic!("shard should encrypt: {error:?}"),
    };

    let mut bad_magic = encrypted.bytes.clone();
    bad_magic[0] ^= 0x01;
    assert_eq!(
        decrypt_shard(&bad_magic, &key),
        Err(MosaicCryptoError::InvalidEnvelope)
    );

    let mut bad_reserved = encrypted.bytes.clone();
    bad_reserved[38] = 1;
    assert_eq!(
        decrypt_shard(&bad_reserved, &key),
        Err(MosaicCryptoError::InvalidEnvelope)
    );

    let mut tampered_tier = encrypted.bytes.clone();
    tampered_tier[37] = ShardTier::Preview.to_byte();
    assert_eq!(
        decrypt_shard(&tampered_tier, &key),
        Err(MosaicCryptoError::AuthenticationFailed)
    );

    let mut tampered_ciphertext = encrypted.bytes;
    let last_index = tampered_ciphertext.len() - 1;
    tampered_ciphertext[last_index] ^= 0x01;
    assert_eq!(
        decrypt_shard(&tampered_ciphertext, &key),
        Err(MosaicCryptoError::AuthenticationFailed)
    );
}

#[test]
fn key_wrap_round_trips_and_rejects_tampering() {
    let key = secret_key_from(KEY_BYTES);
    let wrapper = secret_key_from(WRONG_KEY_BYTES);

    let wrapped = match wrap_key(key.as_bytes(), &wrapper) {
        Ok(value) => value,
        Err(error) => panic!("key should wrap: {error:?}"),
    };

    assert_eq!(wrapped.len(), 24 + KEY_BYTES.len() + 16);
    assert_ne!(&wrapped[0..24], &[0_u8; 24]);

    let unwrapped = match unwrap_key(&wrapped, &wrapper) {
        Ok(value) => value,
        Err(error) => panic!("key should unwrap: {error:?}"),
    };
    assert_eq!(unwrapped.as_slice(), KEY_BYTES);

    let mut tampered = wrapped;
    tampered[30] ^= 0x80;
    let error = match unwrap_key(&tampered, &wrapper) {
        Ok(_) => panic!("tampered key should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::AuthenticationFailed);
}

#[test]
fn key_wrap_rejects_short_wrapped_input() {
    let wrapper = secret_key_from(WRONG_KEY_BYTES);

    let error = match unwrap_key(&[0_u8; 40], &wrapper) {
        Ok(_) => panic!("short wrapped input should fail"),
        Err(error) => error,
    };

    assert_eq!(error, MosaicCryptoError::WrappedKeyTooShort { actual: 40 });
}
