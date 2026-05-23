use mosaic_crypto::{
    MosaicCryptoError, derive_session_master_key, derive_session_salt, derive_session_salt_v2,
};
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

// ---------------------------------------------------------------------------
// v1.0.2 length-prefixed derive_session_salt_v2
// ---------------------------------------------------------------------------

#[test]
fn derive_session_salt_v2_rejects_empty_domain() {
    match derive_session_salt_v2("", USERNAME) {
        Err(MosaicCryptoError::EmptyContext) => {}
        other => panic!("expected EmptyContext, got {other:?}"),
    }
}

#[test]
fn derive_session_salt_v2_produces_16_bytes() {
    let salt = match derive_session_salt_v2(DOMAIN, USERNAME) {
        Ok(salt) => salt,
        Err(error) => panic!("v2 derive failed: {error:?}"),
    };
    assert_eq!(salt.len(), 16);
}

#[test]
fn derive_session_salt_v2_is_deterministic() {
    let a = derive_session_salt_v2(DOMAIN, USERNAME).expect("v2 derive ok");
    let b = derive_session_salt_v2(DOMAIN, USERNAME).expect("v2 derive ok");
    assert_eq!(a, b);
}

#[test]
fn derive_session_salt_v2_distinguishes_boundary_shifts() {
    // The whole point of length-prefix encoding: a byte shifted between
    // domain and username must NOT produce the same salt. Under v1 these
    // two inputs hash identically.
    let v1_left = derive_session_salt("alice.example.com", "bob").expect("v1");
    let v1_right = derive_session_salt("alice.example.comb", "ob").expect("v1");
    assert_eq!(
        v1_left, v1_right,
        "v1 baseline: boundary shift collides (the bug the v2 fix targets)"
    );

    let v2_left = derive_session_salt_v2("alice.example.com", "bob").expect("v2");
    let v2_right = derive_session_salt_v2("alice.example.comb", "ob").expect("v2");
    assert_ne!(
        v2_left, v2_right,
        "v2 length-prefix must break the boundary-shift collision"
    );
}

#[test]
fn derive_session_salt_v2_differs_from_v1_for_same_input() {
    // The encoding is intentionally different — v1 vs v2 callers must
    // never accidentally produce the same salt for the same (domain,
    // username) pair, otherwise the version bump is meaningless.
    let v1 = derive_session_salt(DOMAIN, USERNAME).expect("v1");
    let v2 = derive_session_salt_v2(DOMAIN, USERNAME).expect("v2");
    assert_ne!(v1, v2);
}

#[test]
fn derive_session_salt_v2_accepts_empty_username() {
    let salt = derive_session_salt_v2(DOMAIN, "").expect("empty username ok");
    assert_eq!(salt.len(), 16);
    // Length-prefixed empty username must still differ from the
    // single-field case (which is impossible to express in v2, but we
    // can at least verify it isn't equal to the v1 derivation).
    let v1 = derive_session_salt(DOMAIN, "").expect("v1 empty username");
    assert_ne!(salt, v1);
}
