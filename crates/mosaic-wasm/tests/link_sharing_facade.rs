//! WASM facade tests for share-link sharing exports.
//!
//! Exercises `generateLinkSecret`, `deriveLinkKeys`, `wrapTierKeyForLink`,
//! and `unwrapTierKeyFromLink` through the public Rust facade entry points
//! that the wasm-bindgen `*_js` wrappers ultimately call.

use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB, derive_account_key};
use mosaic_vectors::{load_vector, vectors::LinkKeysVector};
use mosaic_wasm::{
    AccountUnlockRequest, close_account_key_handle, close_epoch_key_handle,
    create_epoch_key_handle, derive_link_keys, generate_link_secret, get_tier_key_from_epoch,
    unlock_account_key, unwrap_tier_key_from_link, wrap_tier_key_for_link,
};
use std::path::PathBuf;

const PASSWORD: &[u8] = b"correct horse battery staple";
const USER_SALT: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const ACCOUNT_SALT: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];

fn unlock_request(wrapped_account_key: Vec<u8>) -> AccountUnlockRequest {
    AccountUnlockRequest {
        user_salt: USER_SALT.to_vec(),
        account_salt: ACCOUNT_SALT.to_vec(),
        wrapped_account_key,
        kdf_memory_kib: MIN_KDF_MEMORY_KIB,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    }
}

fn wrapped_account_key() -> Vec<u8> {
    let profile = match KdfProfile::new(MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic profile should be valid: {error:?}"),
    };
    let material =
        match derive_account_key(PASSWORD.to_vec().into(), &USER_SALT, &ACCOUNT_SALT, profile) {
            Ok(value) => value,
            Err(error) => panic!("account key should derive: {error:?}"),
        };
    material.wrapped_account_key
}

fn corpus_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let mut path = PathBuf::from(manifest_dir);
    path.pop(); // crates/
    path.pop(); // repo root
    path.push("tests");
    path.push("vectors");
    path.push(name);
    path
}

#[test]
fn generate_link_secret_returns_thirty_two_random_bytes() {
    let first = generate_link_secret();
    assert_eq!(first.code, 0);
    assert_eq!(first.bytes.len(), 32);

    let second = generate_link_secret();
    assert_eq!(second.code, 0);
    assert_eq!(second.bytes.len(), 32);

    assert_ne!(
        first.bytes, second.bytes,
        "generate_link_secret must use the OS CSPRNG"
    );
}

#[test]
fn derive_link_keys_matches_golden_vector() {
    let parsed = match load_vector(&corpus_path("link_keys.json")) {
        Ok(value) => value,
        Err(error) => panic!("link_keys.json must load: {error}"),
    };
    let vector = match LinkKeysVector::from(&parsed) {
        Ok(value) => value,
        Err(error) => panic!("link_keys.json must parse: {error}"),
    };

    let result = derive_link_keys(vector.link_secret.clone());
    assert_eq!(result.code, 0);
    assert_eq!(result.link_id, vector.expected_link_id);
    assert_eq!(result.wrapping_key, vector.expected_wrapping_key);
}

#[test]
fn derive_link_keys_rejects_short_secret() {
    let truncated = vec![0_u8; 31];
    let result = derive_link_keys(truncated);
    assert_eq!(result.code, ClientErrorCode::InvalidKeyLength.as_u16());
    assert!(result.link_id.is_empty());
    assert!(result.wrapping_key.is_empty());
}

#[test]
fn wrap_and_unwrap_tier_key_round_trips_through_handle() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch = create_epoch_key_handle(unlock.handle, 11);
    assert_eq!(epoch.code, 0);

    let secret = generate_link_secret();
    assert_eq!(secret.code, 0);
    let derived = derive_link_keys(secret.bytes.clone());
    assert_eq!(derived.code, 0);

    let tier_key = get_tier_key_from_epoch(epoch.handle, 1);
    assert_eq!(tier_key.code, 0);
    assert_eq!(tier_key.bytes.len(), 32);

    let wrapped = wrap_tier_key_for_link(epoch.handle, 1, derived.wrapping_key.clone());
    assert_eq!(wrapped.code, 0);
    assert_eq!(wrapped.tier, 1);
    assert_eq!(wrapped.nonce.len(), 24);
    assert_eq!(wrapped.encrypted_key.len(), 32 + 16);

    let unwrapped = unwrap_tier_key_from_link(
        wrapped.nonce.clone(),
        wrapped.encrypted_key.clone(),
        1,
        derived.wrapping_key.clone(),
    );
    assert_eq!(unwrapped.code, 0);
    assert_eq!(unwrapped.bytes, tier_key.bytes);

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn wrap_tier_key_for_link_rejects_invalid_handle() {
    let derived = derive_link_keys(vec![0x42; 32]);
    assert_eq!(derived.code, 0);

    let wrapped = wrap_tier_key_for_link(0, 1, derived.wrapping_key);
    assert_eq!(wrapped.code, ClientErrorCode::EpochHandleNotFound.as_u16());
    assert!(wrapped.nonce.is_empty());
    assert!(wrapped.encrypted_key.is_empty());
}

#[test]
fn wrap_tier_key_for_link_rejects_invalid_tier_byte() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch = create_epoch_key_handle(unlock.handle, 12);
    assert_eq!(epoch.code, 0);

    let derived = derive_link_keys(vec![0x42; 32]);
    assert_eq!(derived.code, 0);

    let wrapped = wrap_tier_key_for_link(epoch.handle, 99, derived.wrapping_key);
    assert_eq!(wrapped.code, ClientErrorCode::InvalidTier.as_u16());

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn unwrap_tier_key_from_link_rejects_short_nonce() {
    let derived = derive_link_keys(vec![0x42; 32]);
    let result = unwrap_tier_key_from_link(vec![0; 23], vec![0; 48], 1, derived.wrapping_key);
    assert_eq!(result.code, ClientErrorCode::InvalidInputLength.as_u16());
}

#[test]
fn unwrap_tier_key_from_link_rejects_tampered_ciphertext() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    let epoch = create_epoch_key_handle(unlock.handle, 13);

    let derived = derive_link_keys(vec![0x9f; 32]);
    let wrapped = wrap_tier_key_for_link(epoch.handle, 2, derived.wrapping_key.clone());
    assert_eq!(wrapped.code, 0);

    let mut tampered = wrapped.encrypted_key.clone();
    tampered[0] ^= 0x01;
    let result = unwrap_tier_key_from_link(
        wrapped.nonce.clone(),
        tampered,
        2,
        derived.wrapping_key.clone(),
    );
    assert_eq!(result.code, ClientErrorCode::AuthenticationFailed.as_u16());
    assert!(result.bytes.is_empty());

    let bad_wrapping = unwrap_tier_key_from_link(
        wrapped.nonce.clone(),
        wrapped.encrypted_key.clone(),
        2,
        // Wrong wrapping key bytes => AEAD authentication failure.
        vec![0_u8; 32],
    );
    assert_eq!(
        bad_wrapping.code,
        ClientErrorCode::AuthenticationFailed.as_u16()
    );

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}
