// Test-only allowlist: `expect()` is idiomatic for `assert!`-style failure
// reporting in cross-client crypto tests, and `aes_gcm` 0.10 still uses
// generic-array 0.14's `from_slice` until the workspace upgrades to
// generic-array 1.x.
#![allow(clippy::expect_used, deprecated)]

use aes_gcm::{Aes256Gcm, KeyInit, Nonce as AesGcmNonce, aead::Aead};
use mosaic_crypto::{
    AES_GCM_NONCE_BYTES, SESSION_SALT_BYTES, SecretKey, Sha256Hasher,
    decrypt_user_salt_envelope_v2, decrypt_user_salt_v1_legacy, derive_enumeration_defense_salt,
    encrypt_user_salt_envelope_v2_with_nonce, generate_cache_wrap_key, generate_user_salt_bytes,
    sha256_hex, tus_patch_idempotency_key, unwrap_cache_blob, unwrap_link_tier_blob,
    wrap_cache_blob, wrap_link_tier_blob,
};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use zeroize::Zeroizing;

fn fixed_secret(byte: u8) -> SecretKey {
    let mut bytes = [byte; 32];
    SecretKey::from_bytes(&mut bytes).expect("fixed key")
}

#[test]
fn generate_user_salt_returns_sixteen_random_bytes() {
    let first = generate_user_salt_bytes().expect("salt");
    let second = generate_user_salt_bytes().expect("salt");
    assert_eq!(first.len(), SESSION_SALT_BYTES);
    assert_eq!(second.len(), SESSION_SALT_BYTES);
    assert_ne!(first, second, "two CSPRNG salts unexpectedly matched");
}

#[test]
fn user_salt_envelope_v2_is_versioned_and_round_trips() {
    let account_key = fixed_secret(0x42);
    let salt = [0x11_u8; SESSION_SALT_BYTES];
    let nonce = [0x22_u8; AES_GCM_NONCE_BYTES];

    let ciphertext =
        encrypt_user_salt_envelope_v2_with_nonce(&account_key, &salt, &nonce).expect("encrypt");

    assert_eq!(ciphertext[0], 0x02);
    assert_eq!(ciphertext.len(), 1 + SESSION_SALT_BYTES + 16);
    assert_eq!(
        decrypt_user_salt_envelope_v2(&account_key, &ciphertext, &nonce).expect("decrypt"),
        salt
    );
}

#[test]
fn legacy_user_salt_decrypt_matches_pbkdf2_aes_gcm_wire_format() {
    let password = "correct horse battery staple";
    let username = "alice";
    let salt = [0x33_u8; SESSION_SALT_BYTES];
    let nonce = [0x44_u8; AES_GCM_NONCE_BYTES];
    let mut key = Zeroizing::new(vec![0_u8; 32]);
    pbkdf2_hmac::<Sha256>(
        password.as_bytes(),
        username.as_bytes(),
        100_000,
        key.as_mut_slice(),
    );
    let cipher = Aes256Gcm::new_from_slice(key.as_slice()).expect("aes key");
    let ciphertext = cipher
        .encrypt(AesGcmNonce::from_slice(&nonce), salt.as_slice())
        .expect("encrypt fixture");

    let decrypted =
        decrypt_user_salt_v1_legacy(password, username, &ciphertext, &nonce).expect("decrypt");

    assert_eq!(decrypted, salt);
}

#[test]
fn cache_and_link_tier_blob_wrappers_are_domain_separated() {
    let key = generate_cache_wrap_key().expect("wrap key");
    let plaintext = br#"{"payload":"secret"}"#;

    let cache = wrap_cache_blob(&key, plaintext).expect("cache wrap");
    let link = wrap_link_tier_blob(&key, plaintext).expect("link wrap");

    assert_eq!(
        unwrap_cache_blob(&key, &cache)
            .expect("cache unwrap")
            .as_slice(),
        plaintext
    );
    assert_eq!(
        unwrap_link_tier_blob(&key, &link)
            .expect("link unwrap")
            .as_slice(),
        plaintext
    );
    assert!(unwrap_link_tier_blob(&key, &cache).is_err());
    assert!(unwrap_cache_blob(&key, &link).is_err());
}

#[test]
fn tus_patch_idempotency_key_matches_sha256_base64url_truncation() {
    assert_eq!(
        tus_patch_idempotency_key("job-123", "shard-456"),
        "mosaic-tus-patch-oEcT48mRg-HSAGGHuUKrreds"
    );
}

#[test]
fn streaming_sha256_hasher_matches_one_shot_hash() {
    let mut hasher = Sha256Hasher::new();
    hasher.update(b"abc").expect("update");
    hasher.update(b"def").expect("update");
    assert_eq!(
        hasher.finalize_hex().expect("finalize"),
        sha256_hex(b"abcdef")
    );
    assert!(hasher.finalize_bytes().is_err());
}

#[test]
fn enumeration_defense_salt_matches_backend_construction() {
    assert_eq!(
        derive_enumeration_defense_salt(b"server-secret", "alice"),
        [
            0x13, 0xb5, 0x27, 0x99, 0xbe, 0xf3, 0xeb, 0x6d, 0xcb, 0x61, 0xd6, 0xdd, 0x9d, 0x5c,
            0x32, 0x71,
        ]
    );
}
