use mosaic_crypto::{MosaicCryptoError, derive_session_master_key, derive_session_salt};
use zeroize::Zeroizing;

const DOMAIN: &str = "v2:";
const USERNAME: &str = "alice";
const PASSWORD: &[u8] = b"hunter2";
const GOLDEN_SALT: [u8; 16] = [
    0xb5, 0xea, 0x3b, 0xe8, 0xd2, 0x62, 0xca, 0xab, 0x42, 0x64, 0x6f, 0x5b, 0x8e, 0xa3, 0xe0, 0xcc,
];
const GOLDEN_MASTER_KEY: [u8; 32] = [
    0xd6, 0xa6, 0xd3, 0x48, 0x7d, 0xcb, 0x94, 0xc4, 0xa1, 0x14, 0xca, 0x6d, 0xcb, 0xce, 0xe7, 0x25,
    0xf1, 0x80, 0x50, 0x54, 0x71, 0xc4, 0x17, 0xe8, 0xe5, 0x77, 0x60, 0x7b, 0x41, 0x2c, 0xe1, 0x6b,
];

#[test]
fn derive_session_salt_matches_libsodium_blake2b_128_vector() {
    let salt = match derive_session_salt(DOMAIN, USERNAME) {
        Ok(salt) => salt,
        Err(error) => panic!("derive session salt failed: {error:?}"),
    };
    assert_eq!(salt, GOLDEN_SALT);
}

#[test]
fn derive_session_salt_accepts_empty_username_for_web_compatibility() {
    let salt = match derive_session_salt(DOMAIN, "") {
        Ok(salt) => salt,
        Err(error) => panic!("derive session salt for empty username failed: {error:?}"),
    };
    assert_eq!(salt.len(), 16);
}

#[test]
fn derive_session_master_key_matches_libsodium_argon2id13_vector() {
    let key = match derive_session_master_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &GOLDEN_SALT,
        2,
        64 * 1024,
    ) {
        Ok(key) => key,
        Err(error) => panic!("derive session master key failed: {error:?}"),
    };

    assert_eq!(key.as_bytes(), &GOLDEN_MASTER_KEY);
}

#[test]
fn derive_session_master_key_rejects_non_sodium_salt_length() {
    let error = match derive_session_master_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &[0_u8; 15],
        2,
        64 * 1024,
    ) {
        Ok(_) => panic!("invalid salt length must be rejected"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidSaltLength { actual: 15 });
}
