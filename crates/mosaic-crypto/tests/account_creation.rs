//! Round-trip tests for `derive_db_session_key` and `wrap_account_key` —
//! the helpers Slice 2 added to support the worker's account-handle
//! migration.

use mosaic_crypto::{
    AccountKeyMaterial, KdfProfile, MosaicCryptoError, SecretKey, derive_account_key,
    derive_db_session_key, unwrap_account_key, wrap_account_key,
};
use zeroize::Zeroizing;

const PASSWORD: &[u8] = b"correct horse battery staple";
const USER_SALT: [u8; 16] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
const ACCOUNT_SALT: [u8; 16] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
];

fn weak_profile() -> KdfProfile {
    match KdfProfile::new(64 * 1024, 3, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic profile should be valid: {error:?}"),
    }
}

fn fresh_account_material() -> AccountKeyMaterial {
    let profile = weak_profile();
    match derive_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("derive account key should succeed: {error:?}"),
    }
}

fn secret_from_bytes(bytes: [u8; 32]) -> SecretKey {
    let mut buf = bytes;
    match SecretKey::from_bytes(buf.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => panic!("secret key should accept 32 bytes: {error:?}"),
    }
}

#[test]
fn db_session_key_is_thirty_two_bytes_and_deterministic() {
    let mut bytes = [0_u8; 32];
    bytes[0] = 0x01;
    let secret = secret_from_bytes(bytes);

    let derived_a = match derive_db_session_key(&secret) {
        Ok(value) => value,
        Err(error) => panic!("derive_db_session_key should succeed: {error:?}"),
    };
    let derived_b = match derive_db_session_key(&secret) {
        Ok(value) => value,
        Err(error) => panic!("derive_db_session_key should succeed (call 2): {error:?}"),
    };

    assert_eq!(derived_a.as_bytes().len(), 32);
    assert_eq!(derived_a.as_bytes(), derived_b.as_bytes());
    assert_ne!(derived_a.as_bytes(), &bytes[..]);
}

#[test]
fn db_session_key_is_distinct_per_account_key() {
    let secret_a = secret_from_bytes([0xa5_u8; 32]);
    let secret_b = secret_from_bytes([0x5a_u8; 32]);

    let derived_a = match derive_db_session_key(&secret_a) {
        Ok(value) => value,
        Err(error) => panic!("derive_db_session_key (a) should succeed: {error:?}"),
    };
    let derived_b = match derive_db_session_key(&secret_b) {
        Ok(value) => value,
        Err(error) => panic!("derive_db_session_key (b) should succeed: {error:?}"),
    };

    assert_ne!(derived_a.as_bytes(), derived_b.as_bytes());
}

#[test]
fn wrap_account_key_round_trips_through_unwrap() {
    let profile = weak_profile();
    let material = fresh_account_material();

    // Re-wrap with the SAME password+salts and assert the unwrapped bytes
    // match the original L2 (i.e., the wrap function honours the L1
    // derivation path).
    let rewrapped = match wrap_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        &material.account_key,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("wrap_account_key should succeed: {error:?}"),
    };

    let unwrapped = match unwrap_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        &rewrapped,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("unwrap_account_key should succeed: {error:?}"),
    };

    assert_eq!(unwrapped.as_bytes(), material.account_key.as_bytes());
}

#[test]
fn wrap_account_key_fresh_nonce_yields_different_ciphertext() {
    let profile = weak_profile();
    let material = fresh_account_material();

    let wrap_a = match wrap_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        &material.account_key,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("wrap_account_key (a) should succeed: {error:?}"),
    };

    let wrap_b = match wrap_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        &material.account_key,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("wrap_account_key (b) should succeed: {error:?}"),
    };

    // Two wraps with different random nonces must produce distinct outputs
    // even with identical inputs (otherwise nonce reuse is happening).
    assert_ne!(wrap_a, wrap_b);
}

#[test]
fn wrap_account_key_rejects_short_user_salt() {
    let profile = weak_profile();
    let material = fresh_account_material();

    let bad_salt = [0_u8; 8];
    let result = wrap_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &bad_salt,
        &ACCOUNT_SALT,
        &material.account_key,
        profile,
    );

    match result {
        Err(MosaicCryptoError::InvalidSaltLength { actual: 8 }) => {}
        Err(other) => panic!("expected InvalidSaltLength for 8-byte salt, got {other:?}"),
        Ok(_) => panic!("expected InvalidSaltLength for 8-byte salt, got Ok(_)"),
    }
}

#[test]
fn unwrap_with_wrong_password_fails_authentication() {
    let profile = weak_profile();
    let material = fresh_account_material();

    let wrapped = match wrap_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        &material.account_key,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("wrap_account_key should succeed: {error:?}"),
    };

    let result = unwrap_account_key(
        Zeroizing::new(b"wrong password".to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        &wrapped,
        profile,
    );

    match result {
        Err(MosaicCryptoError::AuthenticationFailed) => {}
        Err(other) => panic!("expected AuthenticationFailed for wrong password, got {other:?}"),
        Ok(_) => panic!("expected AuthenticationFailed for wrong password, got Ok(_)"),
    }
}
